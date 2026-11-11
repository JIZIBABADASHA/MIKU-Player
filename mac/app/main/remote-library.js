'use strict';
// 遠端音樂庫: the libraries of MIKU on other computers (a Windows PC at home…), reached over the home network or
// Tailscale. This Mac pairs with each one's phone-remote server once (a 4-digit code shown there), lists their songs
// together under 遠端 and plays them with this Mac's own engine: streamed from there at once (FFmpeg reads the address),
// the next ones of the queue copied into a cache meanwhile. Whole albums can be kept on this Mac (離線下載).
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { app } = require('electron');
const { AppPaths, Log, Json, hash } = require('./common');

const Dir = path.join(AppPaths.Root, 'Remote');                 // the library lists and the offline albums: kept
const OfflineDir = path.join(Dir, 'Offline');
const CacheDir = path.join(app.getPath('cache'), 'MIKU', 'Remote');   // songs played lately: may be cleared
const ArtDir = path.join(CacheDir, 'Art');
const IndexFile = path.join(Dir, 'files.json');
const Lossy = new Set(['MP3', 'AAC', 'OGG', 'OPUS', 'WMA']);
// what this Mac's engine (FFmpeg) plays as it is when a smaller copy is asked for: a lossy file is never encoded again
const Caps = 'mp3,aac,alac,flac,wav,ogg,opus';
const ExtOfType = { 'audio/mpeg': '.mp3', 'audio/aac': '.aac', 'audio/mp4': '.m4a', 'audio/flac': '.flac', 'audio/wav': '.wav', 'audio/ogg': '.ogg' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Several computers can be paired; their songs are shown together under 遠端. Ids are "<key>~<id there>" (two
// computers can have the same file path, so the same id); key: a short hash of the computer's address.
const keyOf = url => hash(url).slice(0, 6);
// a file or folder name made from a title (offline albums are kept as Artist - Album / 01 Title.ext)
const safeName = s => String(s || '').replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100).replace(/[. ]+$/, '') || '_';
const split = id => { const i = id ? id.indexOf('~') : -1; return i > 0 ? [id.slice(0, i), id.slice(i + 1)] : [null, id]; };

class RemoteLibrary extends EventEmitter {
  constructor(s) {
    super();
    this.s = s;
    const d = { remotes: [], active: false, only: '', quality: 'orig', cacheGB: 5, offlineDir: '' };
    const c = s.remoteLib = Object.assign(d, s.remoteLib && typeof s.remoteLib === 'object' ? s.remoteLib : {});
    // one computer, as the first version kept it
    if (c.url && c.token && !c.remotes.length) c.remotes.push({ url: c.url, token: c.token, name: c.name || '' });
    delete c.url; delete c.token; delete c.name;
    this.state = new Map();       // key → { online, error, events, data (library.json parsed), raw }
    this.tracks = new Map(); this.albums = new Map();
    this.merged = null;           // the library.json the page reads (all computers, or the one chosen)
    this.files = {};              // id → { file, size, q, used, pin }
    this.jobs = new Map();        // id|q → running download { promise, got, total, ac }
    this.lastError = ''; this.pairing = null;
    this.offlineQueue = []; this.offlineBusy = false; this.offlineDone = 0; this.offlineTotal = 0;
    this.playingId = null;
    try { fs.mkdirSync(OfflineDir, { recursive: true }); fs.mkdirSync(ArtDir, { recursive: true }); } catch { }
    this.files = Json.load(IndexFile, {}) || {};
    for (const [id, f] of Object.entries(this.files)) if (!f || !f.file || !fs.existsSync(f.file)) delete this.files[id];
    for (const r of this.cfg.remotes) {
      const st = this.st(r);
      try { st.raw = fs.readFileSync(this.libFile(r)); st.data = JSON.parse(st.raw.toString('utf8')); } catch { }
    }
    this.rebuild();
  }

  get cfg() { return this.s.remoteLib; }
  get paired() { return this.cfg.remotes.length > 0; }
  get active() { return this.paired && this.cfg.active === true && !!this.merged; }
  get online() { return this.cfg.remotes.some(r => this.st(r).online); }
  st(r) { const k = keyOf(r.url); let st = this.state.get(k); if (!st) this.state.set(k, st = { online: false, error: '', events: null, data: null, raw: null }); return st; }
  remoteOf(id) { const [k] = split(id); return k ? this.cfg.remotes.find(r => keyOf(r.url) === k) || null : null; }
  libFile(r) { return path.join(Dir, 'lib-' + keyOf(r.url) + '.json'); }
  label(r) { return r.name || r.url.replace(/^https?:\/\//, ''); }

  // ───────────── the library ─────────────
  /** All the computers' libraries (or only the one chosen) as one: ids prefixed, folders numbered on. */
  rebuild() {
    const albums = new Map(), tracks = new Map();
    const out = { revision: Date.now(), albums: [], tracks: [], folders: [] };
    let any = false;
    for (const r of this.cfg.remotes) {
      const k = keyOf(r.url), data = this.st(r).data;
      if (!data) continue;
      any = true;
      const shown = !this.cfg.only || this.cfg.only === k;
      const fo = out.folders.length;
      if (shown) out.folders.push(...(data.folders || []));
      for (const a of data.albums || []) {
        const id = k + '~' + a[0];
        albums.set(id, { id, title: a[1] || '', artist: a[2] || '', year: a[3] || 0, genre: a[4] || '', tracks: [], remote: true });
        if (shown) { const b = a.slice(); b[0] = id; out.albums.push(b); }
      }
      for (const r2 of data.tracks || []) {
        // [id, title, artist, albumId, disc, no, duration, codec, rate, bits, year, composer, added, folder]
        const id = k + '~' + r2[0], albumId = k + '~' + r2[3];
        const al = albums.get(albumId);
        const base = { codec: r2[7] || '', sampleRate: r2[8] || 0, bits: r2[9] || 0, channels: 2 };
        let t = this.tracks.get(id);
        const fresh = {
          id, title: r2[1] || '', artist: r2[2] || '', albumArtist: al ? al.artist : '', album: al ? al.title : '', albumId,
          discNo: r2[4] || 1, trackNo: r2[5] || 0, duration: r2[6] || 0, year: r2[10] || 0, composer: r2[11] || '', genre: al ? al.genre : '',
          hasPic: false, remote: true, base,
        };
        // a track the player holds keeps its object (and where it plays from)
        if (t && t.path) Object.assign(t, fresh); else t = Object.assign(fresh, base, { path: '' });
        tracks.set(id, t);
        if (al) al.tracks.push(t);
        if (shown) { const b = r2.slice(); b[0] = id; b[3] = albumId; if (typeof b[13] === 'number') b[13] += fo; out.tracks.push(b); }
      }
    }
    this.albums = albums; this.tracks = tracks;
    this.merged = any ? Buffer.from(JSON.stringify(out)) : null;
  }

  getTrack(id) { return id ? this.tracks.get(id) || null : null; }
  getAlbum(id) { return id ? this.albums.get(id) || null : null; }

  /** The library.json the page reads while 遠端 is shown (the last one fetched, also without a connection). */
  json() { return this.merged; }

  // ───────────── talking to the other computers ─────────────
  async req(r, p, opts = {}, ms = 15000) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    if (opts.signal) opts.signal.addEventListener('abort', () => ac.abort(), { once: true });
    try {
      const headers = Object.assign({}, opts.headers || {});
      if (r.token) headers['X-Miku-Token'] = r.token;
      if (opts.body) headers['Content-Type'] = 'application/json';
      const res = await fetch(r.url + p, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined, signal: ac.signal });
      if (res.status === 401 && r.token && !p.startsWith('/api/pair')) this.unauthorized(r);
      return res;
    } catch (e) {
      if (ac.signal.aborted && !(opts.signal && opts.signal.aborted)) throw new Error(`連不上「${this.label(r)}」（逾時）`);
      throw new Error(`連不上「${this.label(r)}」：` + (e.cause && e.cause.code || e.message));
    } finally { clearTimeout(timer); }
  }

  unauthorized(r) {
    // the other computer forgot this one (取消配對 there): pair again
    this.lastError = `「${this.label(r)}」已取消這台電腦的配對，請重新配對。`;
    this.unpair(keyOf(r.url));
  }

  static normalize(u) {
    u = String(u || '').trim();
    if (!u) throw new Error('請輸入另一台 MIKU 的網址');
    if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
    const x = new URL(u);
    if (!x.port) x.port = '8765';
    return x.origin;
  }

  /** Step 1: the other MIKU shows a pairing code. */
  async pairStart(u) {
    const url = RemoteLibrary.normalize(u);
    if (this.cfg.remotes.some(r => r.url === url)) throw new Error('已經和這台電腦配對了');
    const r = { url, token: '', name: '' };
    const ping = await this.req(r, '/api/ping', {}, 8000);
    const j = await ping.json().catch(() => null);
    if (!j || j.app !== 'MIKU') throw new Error('這個網址不是 MIKU，請確認網址和連接埠');
    r.name = typeof j.name === 'string' ? j.name.slice(0, 40) : '';
    const res = await this.req(r, '/api/pair/request', { method: 'POST', body: { name: this.deviceName() } }, 8000);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).e || '配對要求失敗（' + res.status + '）');
    this.pairing = r; this.lastError = '';
    this.emit('changed');
    return { ok: true };
  }

  /** Step 2: the code read off the other computer's screen. */
  async pairConfirm(code) {
    const r = this.pairing;
    if (!r) throw new Error('請先取得配對碼');
    const res = await this.req(r, '/api/pair/confirm', { method: 'POST', body: { code: String(code || '').trim(), name: this.deviceName() } }, 8000);
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.token) throw new Error(j.e || '配對失敗');
    r.token = j.token;
    this.cfg.remotes.push(r); this.cfg.active = true; this.pairing = null; this.lastError = '';
    this.emit('save');
    await this.refresh(r);
    this.emit('library');
    return this.info();
  }

  cancelPairing() { this.pairing = null; this.emit('changed'); }

  unpair(key) {
    const r = this.cfg.remotes.find(x => keyOf(x.url) === key);
    if (!r) return;
    const st = this.st(r);
    this.stopEvents(st);
    this.cfg.remotes = this.cfg.remotes.filter(x => x !== r);
    if (this.cfg.only === key) this.cfg.only = '';
    if (!this.cfg.remotes.length) this.cfg.active = false;
    this.state.delete(key);
    try { fs.unlinkSync(this.libFile(r)); } catch { }
    this.rebuild();
    this.emit('save'); this.emit('changed'); this.emit('library');
  }

  deviceName() {
    let n = os.hostname().replace(/\.local$/i, '');
    return (n || 'Mac').slice(0, 30) + ' 的 MIKU';
  }

  setActive(on) {
    this.cfg.active = on === true && this.paired;
    this.emit('save'); this.emit('library'); this.emit('changed');
    if (this.cfg.active) { this.refresh().catch(() => { }); this.startEvents(); } else this.stopEvents();
  }

  /** Shows one computer's songs only ('' all of them). */
  setOnly(key) {
    this.cfg.only = key && this.cfg.remotes.some(r => keyOf(r.url) === key) ? key : '';
    this.rebuild();
    this.emit('save'); this.emit('library'); this.emit('changed');
  }

  /** Fetches the library.json of one computer (or all), kept on disk: listed without a connection too. */
  async refresh(only) {
    const list = only ? [only] : this.cfg.remotes.slice();
    const results = await Promise.all(list.map(async r => {
      const st = this.st(r);
      try {
        const res = await this.req(r, '/media/library.json', {}, 60000);
        if (!res.ok) throw new Error('讀取音樂庫失敗（' + res.status + '）');
        const buf = Buffer.from(await res.arrayBuffer());
        const same = st.raw && st.raw.equals(buf);
        if (!same) {
          st.data = JSON.parse(buf.toString('utf8')); st.raw = buf;
          await fsp.mkdir(Dir, { recursive: true });
          await fsp.writeFile(this.libFile(r) + '.tmp', buf); await fsp.rename(this.libFile(r) + '.tmp', this.libFile(r));
        }
        st.online = true; st.error = '';
        // paired by the first version (no name kept): ask its name
        if (!r.name) { try { const j = await (await this.req(r, '/api/ping', {}, 5000)).json(); if (j && typeof j.name === 'string' && j.name) { r.name = j.name.slice(0, 40); this.emit('save'); } } catch { } }
        return !same;
      } catch (e) {
        st.online = false; st.error = e.message;
        Log.error('Remote library refresh ' + r.url, e);
        return false;
      }
    }));
    const changed = results.some(Boolean);
    if (changed) this.rebuild();
    this.emit('changed');
    if (changed && this.cfg.active) this.emit('library');
    if (this.cfg.active) this.startEvents();
    return results.length > 0;
  }

  /** Each computer's events: its library changed (fetch it again), and whether it can be reached. */
  startEvents() {
    for (const r of this.cfg.remotes) {
      const st = this.st(r);
      if (st.events) continue;
      const run = st.events = { stop: false, ac: null };
      (async () => {
        let wait = 3000;
        while (!run.stop && this.cfg.remotes.includes(r)) {
          try {
            run.ac = new AbortController();
            const res = await fetch(r.url + '/api/events', { headers: { 'X-Miku-Token': r.token, Accept: 'text/event-stream' }, signal: run.ac.signal });
            if (res.status === 401) { this.unauthorized(r); break; }
            if (!res.ok || !res.body) throw new Error('events ' + res.status);
            if (!st.online) { st.online = true; st.error = ''; this.emit('changed'); this.refresh(r).catch(() => { }); }
            wait = 3000;
            const dec = new TextDecoder();
            let buf = '', libTimer = null;
            for await (const chunk of res.body) {
              if (run.stop) break;
              buf += dec.decode(chunk, { stream: true });
              let i;
              while ((i = buf.indexOf('\n\n')) >= 0) {
                const frame = buf.slice(0, i); buf = buf.slice(i + 2);
                const line = frame.split('\n').find(l => l.startsWith('data: '));
                if (!line) continue;
                try {
                  const m = JSON.parse(line.slice(6));
                  if (m.ev === 'library') { clearTimeout(libTimer); libTimer = setTimeout(() => this.refresh(r).catch(() => { }), 2500); }
                } catch { }
              }
            }
          } catch (e) { if (run.stop) break; }
          if (run.stop) break;
          if (st.online) { st.online = false; this.emit('changed'); }
          await sleep(wait); wait = Math.min(wait * 2, 60000);
        }
      })();
    }
  }
  stopEvents(one) {
    for (const st of one ? [one] : this.state.values())
      if (st.events) { st.events.stop = true; try { st.events.ac && st.events.ac.abort(); } catch { } st.events = null; }
  }

  // ───────────── covers ─────────────
  /** A cover (/art/a/<key~id>, /art/t/<key~id>, /art/r/<name>), cached on disk; null when none or out of reach. */
  async art(p, size) {
    const kind = p.slice(0, 7), rest = decodeURIComponent(p.slice(7));
    let list;
    if (kind === '/art/r/') list = this.cfg.remotes.filter(r => !this.cfg.only || keyOf(r.url) === this.cfg.only).map(r => [r, p]);
    else { const r = this.remoteOf(rest); if (!r) return null; list = [[r, kind + encodeURIComponent(split(rest)[1])]]; }
    this.missing = this.missing || new Map();
    for (const [r, there] of list) {
      const file = path.join(ArtDir, hash(r.url + there + '@' + size) + '.jpg');
      try { return await fsp.readFile(file); } catch { }
      const miss = this.missing.get(file);
      if (miss && Date.now() - miss < 10 * 60000) continue;
      try {
        const res = await this.req(r, '/media' + there + '?s=' + size, {}, 20000);
        if (!res.ok) { this.missing.set(file, Date.now()); continue; }
        const buf = Buffer.from(await res.arrayBuffer());
        fsp.writeFile(file, buf).catch(() => { });
        return buf;
      } catch { this.missing.set(file, Date.now()); }
    }
    return null;
  }

  // ───────────── songs ─────────────
  /** The cached copy of a track that can play now: the original when there is one, else the chosen smaller one. */
  cached(t) {
    const f = this.files[t.id];
    if (!f || !fs.existsSync(f.file)) { if (f) delete this.files[t.id]; return null; }
    if (f.q === 'orig' || f.pin || f.q === this.quality(t)) return f;
    return null;
  }

  /** The quality a track is fetched in: lossy files always as they are. */
  quality(t) { const q = this.cfg.quality || 'orig'; return q === 'orig' || Lossy.has(t.base.codec) ? 'orig' : q; }

  /** Points the track at its cached file (its codec too: a smaller copy is an MP3 / AAC). */
  bind(t, f) {
    t.path = f.file;
    if (f.q === 'orig') Object.assign(t, t.base);
    else Object.assign(t, { codec: /\.aac$/i.test(f.file) ? 'AAC' : 'MP3', bits: 0, channels: 2 });
    f.used = Date.now();
  }

  /**
   * The address the engine's FFmpeg reads a song from while it is not in the cache: the file as it is (it seeks in
   * it with HTTP ranges, so playback starts at once and every format plays bit-perfect), or the smaller copy.
   */
  streamUrl(t) {
    const q = this.quality(t);
    const r = this.remoteOf(t.id);
    return r.url + '/stream/' + encodeURIComponent(split(t.id)[1]) + '?' + (q === 'orig' ? 'raw=1' : `q=${q}&c=${Caps}`) + '&t=' + encodeURIComponent(r.token);
  }
  bindStream(t) {
    t.path = this.streamUrl(t);
    if (this.quality(t) === 'orig') Object.assign(t, t.base);
    else Object.assign(t, { codec: 'MP3', bits: 0, channels: 2 });
    t.streaming = true;
  }

  /** Ready to play now (also gapless): in the cache, or streamed while the other computer can be reached. */
  isReady(t) {
    const f = this.cached(t);
    if (f) { this.bind(t, f); t.streaming = false; return true; }
    const r = this.remoteOf(t.id);
    if (r && this.st(r).online) { this.bindStream(t); this.prefetch([t]); return true; }
    return false;
  }

  /**
   * Before a song of the other computer plays: from the cache when it is there, else streamed straight away (the
   * engine plays it as it comes). The next songs of the queue are copied into the cache meanwhile, one at a time.
   */
  async prepare(t, next = []) {
    this.playingId = t.id;
    const f = this.cached(t);
    if (f) { this.bind(t, f); t.streaming = false; this.saveIndex(); }
    else {
      const r = this.remoteOf(t.id);
      if (!r) throw new Error('這首歌所在的電腦已經取消配對');
      const st = this.st(r);
      if (!st.online) {
        try { const res = await this.req(r, '/api/ping', {}, 4000); if (!res.ok) throw new Error(); st.online = true; this.emit('changed'); }
        catch { throw new Error('連不上遠端電腦，這首歌還沒下載到這台電腦'); }
      }
      this.bindStream(t);
    }
    this.prefetch(next.filter(n => n && n.remote));
  }

  /** Copies the given songs into the cache, one after another (the song playing keeps most of the connection). */
  prefetch(list) {
    if (this.noCache()) return;   // 不暫存: songs are only streamed, nothing is kept
    this.pre = (this.pre || []).filter(x => !list.includes(x));
    this.pre.unshift(...list.filter(n => !this.cached(n)));
    this.pre.length = Math.min(this.pre.length, 4);
    if (this.preBusy) return;
    this.preBusy = true;
    (async () => {
      try {
        while (this.pre.length) {
          const n = this.pre.shift();
          if (!this.cached(n)) await this.fetch(n).catch(() => { });
        }
      } finally { this.preBusy = false; }
    })();
  }

  /** Copies one track into the cache; several asks for the same track share one copy. q: 'orig' or the kbps. */
  fetch(t, now = false, q = this.quality(t)) {
    const key = t.id + '|' + q;
    const running = this.jobs.get(key);
    if (running) return running.promise;
    const remote = this.remoteOf(t.id);
    if (!remote) return Promise.reject(new Error('這首歌所在的電腦已經取消配對'));
    // a song that just failed (no connection) is not asked for again at once by the gapless look-ahead
    this.failed = this.failed || new Map();
    if (!now && Date.now() - (this.failed.get(key) || 0) < 60000) return Promise.reject(new Error('稍後再試'));
    const job = { got: 0, total: 0, ac: new AbortController(), title: t.title };
    job.promise = (async () => {
      await fsp.mkdir(CacheDir, { recursive: true });
      const qs = q === 'orig' ? 'raw=1' : `q=${q}&c=${Caps}`;
      let res;
      for (let attempt = 0; ; attempt++) {
        res = await this.req(remote, '/stream/' + encodeURIComponent(split(t.id)[1]) + '?' + qs, { signal: job.ac.signal }, now ? 20000 : 60000);
        if (res.status === 503 && attempt < 5) { await sleep(2000); continue; }   // the PC is encoding several songs
        break;
      }
      if (res.status === 404) throw new Error('遠端電腦上找不到這首歌（檔案可能已移動或刪除）');
      if (res.status === 415) throw new Error(await res.text().catch(() => '無法轉換這首歌'));
      if (!res.ok || !res.body) throw new Error('下載失敗（' + res.status + '）');
      const ext = (res.headers.get('x-miku-ext') || ExtOfType[(res.headers.get('content-type') || '').split(';')[0]] || '.bin').replace(/[^.\w]/g, '');
      job.total = parseInt(res.headers.get('content-length'), 10) || 0;
      const file = path.join(CacheDir, t.id.replace(/[^\w-]/g, '') + (q === 'orig' ? '' : '-' + q) + ext);
      const tmp = file + '.part';
      const out = fs.createWriteStream(tmp);
      try {
        // a stalled connection (the PC went to sleep) must not hang the player forever
        let last = Date.now();
        const watch = setInterval(() => { if (Date.now() - last > 30000) job.ac.abort(); }, 5000);
        try {
          for await (const chunk of res.body) {
            last = Date.now();
            if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
            job.got += chunk.length;
          }
        } finally { clearInterval(watch); }
        await new Promise((ok, bad) => out.end(e => e ? bad(e) : ok()));
      } catch (e) { out.destroy(); await fsp.unlink(tmp).catch(() => { }); throw job.ac.signal.aborted ? new Error('下載中斷：遠端電腦沒有回應') : e; }
      if (job.total && job.got < job.total) { await fsp.unlink(tmp).catch(() => { }); throw new Error('下載不完整，請再試一次'); }
      await fsp.rename(tmp, file);
      const old = this.files[t.id];
      // a song kept offline stays as it is (the copy just made is not needed)
      if (old && old.pin && old.file !== file) { await fsp.unlink(file).catch(() => { }); return old; }
      if (old && old.file !== file) await fsp.unlink(old.file).catch(() => { });
      const f = this.files[t.id] = { file, size: job.got, q, used: Date.now(), pin: false };
      this.saveIndex();
      this.trim();
      return f;
    })();
    this.jobs.set(key, job);
    this.emit('progress');
    job.promise.then(() => { this.jobs.delete(key); this.emit('progress'); },
      e => { this.jobs.delete(key); this.failed.set(key, Date.now()); this.emit('progress'); Log.error('Remote fetch ' + t.id, e); });
    return job.promise;
  }

  /** Moves a cached original into the offline folder: it is no longer cleared with the cache. */
  pin(id) {
    const f = this.files[id];
    if (!f || f.pin) return;
    const dest = this.offlinePath(id, f.file);
    if (this.moveFile(f.file, dest)) { f.file = dest; f.pin = true; }
    this.saveIndex();
  }

  /** The folder offline albums go to: the one chosen in 設定, else MIKU's own. */
  get offlineRoot() { const d = this.cfg.offlineDir; return d && path.isAbsolute(d) ? d : OfflineDir; }

  /** Where a song kept offline goes: <folder>/<Artist - Album>/<01 Title>.ext, a name that is not taken yet. */
  offlinePath(id, from) {
    const t = this.getTrack(id), ext = path.extname(from);
    if (!t) return path.join(this.offlineRoot, path.basename(from));
    const dir = path.join(this.offlineRoot, safeName(`${t.albumArtist || t.artist} - ${t.album || t.title}`));
    const base = safeName(`${t.discNo > 1 ? t.discNo + '-' : ''}${t.trackNo ? String(t.trackNo).padStart(2, '0') + ' ' : ''}${t.title}`);
    let p = path.join(dir, base + ext);
    for (let i = 2; fs.existsSync(p) && path.resolve(p) !== path.resolve(from); i++) p = path.join(dir, `${base} (${i})${ext}`);
    return p;
  }

  /** Moves a file (also to another disk); true when it is there. */
  moveFile(from, dest) {
    if (path.resolve(from) === path.resolve(dest)) return true;
    try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch { }
    try { fs.renameSync(from, dest); return true; }
    catch { try { fs.copyFileSync(from, dest); fs.unlinkSync(from); return true; } catch (e) { Log.error('Remote move', e); return false; } }
  }

  /** Removes a folder an offline album was in once it is empty (never the offline folder itself). */
  dropEmpty(dir) {
    const roots = [OfflineDir, this.offlineRoot].map(d => path.resolve(d));
    if (roots.includes(path.resolve(dir))) return;
    try { if (!fs.readdirSync(dir).filter(n => n !== '.DS_Store').length) fs.rmSync(dir, { recursive: true }); } catch { }
  }

  /** 離線下載 → 位置: the albums kept so far move along to the new folder ('' = MIKU's own). */
  async setOfflineDir(dir) {
    dir = dir && path.isAbsolute(dir) ? dir : '';
    if ((this.cfg.offlineDir || '') === dir) return;
    this.cfg.offlineDir = dir;
    this.emit('save');
    try { fs.mkdirSync(this.offlineRoot, { recursive: true }); } catch { }
    this.moving = true; this.emit('changed');
    try {
      for (const [id, f] of Object.entries(this.files)) {
        if (!f.pin || id === this.playingId) continue;
        const dest = this.offlinePath(id, f.file), old = f.file;
        await new Promise(r => setImmediate(r));
        if (path.resolve(dest) !== path.resolve(old) && this.moveFile(old, dest)) { f.file = dest; this.dropEmpty(path.dirname(old)); }
      }
    } finally { this.moving = false; this.saveIndex(); this.emit('changed'); }
  }

  /** How far the track that is about to play has come (shown while it loads). */
  progress(id) {
    for (const [k, j] of this.jobs) if (k.startsWith(id + '|')) return { got: j.got, total: j.total };
    return null;
  }

  saveIndex() { clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => { try { Json.saveAtomic(IndexFile, this.files); } catch (e) { Log.error('Remote index', e); } }, 1000); }

  /** Keeps the cache of played songs under its size (the oldest go first; offline albums and the playing song stay). */
  /** 暫存空間 set to 不暫存: songs are streamed and not kept (offline albums still are). */
  noCache() { return Number(this.cfg.cacheGB) === 0; }

  trim() {
    const limit = this.noCache() ? 0 : Math.max(0.5, Number(this.cfg.cacheGB) || 5) * 1024 ** 3;
    const list = Object.entries(this.files).filter(([id, f]) => !f.pin && !(this.keep && this.keep.has(id))).sort((a, b) => a[1].used - b[1].used);
    let total = list.reduce((n, [, f]) => n + (f.size || 0), 0);
    for (const [id, f] of list) {
      if (total <= limit) break;
      if (id === this.playingId) continue;
      try { fs.unlinkSync(f.file); } catch { }
      total -= f.size || 0;
      delete this.files[id];
    }
    this.saveIndex();
  }

  clearCache() {
    for (const [id, f] of Object.entries(this.files)) {
      if (f.pin || id === this.playingId) continue;
      try { fs.unlinkSync(f.file); } catch { }
      delete this.files[id];
    }
    try { for (const n of fs.readdirSync(ArtDir)) fs.unlinkSync(path.join(ArtDir, n)); } catch { }
    this.saveIndex(); this.emit('changed');
  }

  // ───────────── offline albums ─────────────
  /** Keeps a whole album on this computer (originals), one song at a time in the background. */
  downloadAlbum(id) {
    const al = this.getAlbum(id);
    if (!al) throw new Error('找不到這張專輯');
    const todo = [];
    for (const t of al.tracks) {
      const f = this.files[t.id];
      if (f && f.pin) continue;
      // a song already cached as the original moves to the offline folder instead of being copied again
      if (f && f.q === 'orig' && fs.existsSync(f.file)) { this.pin(t.id); continue; }
      if (!this.offlineQueue.includes(t)) todo.push(t);
    }
    this.offlineQueue.push(...todo);
    this.offlineTotal += todo.length;
    this.runOffline();
    this.emit('changed');
    return { queued: todo.length };
  }

  async runOffline() {
    if (this.offlineBusy) return;
    this.offlineBusy = true;
    try {
      while (this.offlineQueue.length) {
        const t = this.offlineQueue[0];
        (this.keep = this.keep || new Set()).add(t.id);   // not cleared by trim before it is pinned
        try { await this.fetch(t, true, 'orig'); this.pin(t.id); this.keep.delete(t.id); this.offlineDone++; }
        catch (e) {
          this.keep.delete(t.id);
          this.lastError = `「${t.title}」下載失敗：${e.message}`;
          if (/連不上/.test(e.message)) { const r = this.remoteOf(t.id); this.offlineQueue = this.offlineQueue.filter(x => this.remoteOf(x.id) !== r); continue; }
        }
        this.offlineQueue.shift();
        this.emit('changed');
      }
    } finally {
      this.offlineBusy = false; this.offlineDone = 0; this.offlineTotal = 0;
      this.emit('changed'); this.emit('offlineDone');
    }
  }

  removeAlbum(id) {
    const al = this.getAlbum(id);
    const ids = new Set(al ? al.tracks.map(t => t.id) : []);
    this.offlineQueue = this.offlineQueue.filter(t => !ids.has(t.id));
    for (const tid of ids) {
      const f = this.files[tid];
      if (!f || !f.pin) continue;
      if (tid === this.playingId) { f.pin = false; continue; }
      try { fs.unlinkSync(f.file); } catch { }
      this.dropEmpty(path.dirname(f.file));
      delete this.files[tid];
    }
    this.saveIndex(); this.emit('changed');
  }

  /** How much of an album is kept offline: 'all', 'some' or ''. */
  albumState(id) {
    const al = this.getAlbum(id);
    if (!al || !al.tracks.length) return '';
    const n = al.tracks.filter(t => this.files[t.id] && this.files[t.id].pin).length;
    return n === al.tracks.length ? 'all' : n ? 'some' : '';
  }

  // ───────────── for the page ─────────────
  info() {
    let cache = 0, offline = 0;
    const offAlbums = new Map();
    for (const [id, f] of Object.entries(this.files)) {
      if (f.pin) {
        offline += f.size || 0;
        const t = this.tracks.get(id);
        if (t) { const a = offAlbums.get(t.albumId) || { id: t.albumId, title: t.album, artist: t.albumArtist, have: 0, bytes: 0 }; a.have++; a.bytes += f.size || 0; offAlbums.set(t.albumId, a); }
      } else cache += f.size || 0;
    }
    for (const a of offAlbums.values()) { const al = this.albums.get(a.id); a.count = al ? al.tracks.length : a.have; }
    const ids = new Set(Object.entries(this.files).filter(([, f]) => f.pin).map(([id]) => id));
    return {
      paired: this.paired, pairing: this.pairing ? { url: this.pairing.url, name: this.pairing.name } : null, active: this.active, online: this.online, error: this.lastError,
      only: this.cfg.only || '',
      remotes: this.cfg.remotes.map(r => {
        const st = this.st(r), d = st.data;
        return { key: keyOf(r.url), url: r.url, name: this.label(r), online: st.online, error: st.error, albums: d ? (d.albums || []).length : 0, tracks: d ? (d.tracks || []).length : 0 };
      }),
      albums: this.albums.size, tracks: this.tracks.size, quality: this.cfg.quality || 'orig', cacheGB: this.cfg.cacheGB ?? 5,
      cacheBytes: cache, offlineBytes: offline, offlineDir: this.offlineRoot, offlineCustom: !!this.cfg.offlineDir, moving: !!this.moving, offline: [...offAlbums.values()].sort((a, b) => a.title.localeCompare(b.title)),
      offlineIds: [...ids], downloading: this.offlineQueue.length ? { done: this.offlineDone, total: this.offlineTotal, title: this.offlineQueue[0].title } : null,
    };
  }

  dispose() { this.stopEvents(); for (const j of this.jobs.values()) try { j.ac.abort(); } catch { } try { Json.saveAtomic(IndexFile, this.files); } catch { } }
}

module.exports = { RemoteLibrary };

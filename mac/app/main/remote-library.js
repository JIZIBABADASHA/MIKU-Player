'use strict';
// 遠端音樂庫: the library of MIKU on another computer (the Windows PC at home), reached over the home network or
// Tailscale. This Mac pairs with that MIKU's phone-remote server once (a 4-digit code shown there), then lists its
// library and covers here and plays its songs with this Mac's own engine: a song is copied into a cache first (as it
// is, or encoded smaller when 省流量 is chosen), the next ones while it plays. Whole albums can be kept on this Mac to
// listen without a connection (離線下載).
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { app } = require('electron');
const { AppPaths, Log, Json, hash } = require('./common');

const Dir = path.join(AppPaths.Root, 'Remote');                 // the library list and the offline albums: kept
const OfflineDir = path.join(Dir, 'Offline');
const CacheDir = path.join(app.getPath('cache'), 'MIKU', 'Remote');   // songs played lately: may be cleared
const ArtDir = path.join(CacheDir, 'Art');
const LibFile = path.join(Dir, 'library.json');
const IndexFile = path.join(Dir, 'files.json');
const Lossy = new Set(['MP3', 'AAC', 'OGG', 'OPUS', 'WMA']);
// what this Mac's engine (FFmpeg) plays as it is when a smaller copy is asked for: a lossy file is never encoded again
const Caps = 'mp3,aac,alac,flac,wav,ogg,opus';
const ExtOfType = { 'audio/mpeg': '.mp3', 'audio/aac': '.aac', 'audio/mp4': '.m4a', 'audio/flac': '.flac', 'audio/wav': '.wav', 'audio/ogg': '.ogg' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

class RemoteLibrary extends EventEmitter {
  constructor(s) {
    super();
    this.s = s;
    const d = { url: '', token: '', name: '', active: false, quality: 'orig', cacheGB: 5 };
    s.remoteLib = Object.assign(d, s.remoteLib && typeof s.remoteLib === 'object' ? s.remoteLib : {});
    this.raw = null;              // the library.json bytes as the PC sent them (what the page reads)
    this.tracks = new Map(); this.albums = new Map();
    this.files = {};              // id → { file, size, q, used, pin }
    this.jobs = new Map();        // id → running download { promise, got, total, abort }
    this.online = false; this.lastError = ''; this.pairing = false;
    this.offlineQueue = []; this.offlineBusy = false; this.offlineDone = 0; this.offlineTotal = 0;
    this.playingId = null;
    this.events = null;
    try { fs.mkdirSync(OfflineDir, { recursive: true }); fs.mkdirSync(ArtDir, { recursive: true }); } catch { }
    this.files = Json.load(IndexFile, {}) || {};
    for (const [id, f] of Object.entries(this.files)) if (!f || !f.file || !fs.existsSync(f.file)) delete this.files[id];
    try { this.parse(fs.readFileSync(LibFile)); } catch { }
  }

  get cfg() { return this.s.remoteLib; }
  get paired() { return !!(this.cfg.url && this.cfg.token); }
  get active() { return this.paired && this.cfg.active === true && !!this.raw; }

  // ───────────── the library ─────────────
  parse(buf) {
    const data = JSON.parse(buf.toString('utf8'));
    const albums = new Map(), tracks = new Map();
    for (const a of data.albums || []) albums.set(a[0], { id: a[0], title: a[1] || '', artist: a[2] || '', year: a[3] || 0, genre: a[4] || '', tracks: [], remote: true });
    for (const r of data.tracks || []) {
      const al = albums.get(r[3]);
      const base = { codec: r[7] || '', sampleRate: r[8] || 0, bits: r[9] || 0, channels: 2 };
      // [id, title, artist, albumId, disc, no, duration, codec, rate, bits, year, composer, added, folder]
      const t = Object.assign({
        id: r[0], title: r[1] || '', artist: r[2] || '', albumArtist: al ? al.artist : '', album: al ? al.title : '', albumId: r[3],
        discNo: r[4] || 1, trackNo: r[5] || 0, duration: r[6] || 0, year: r[10] || 0, composer: r[11] || '', genre: al ? al.genre : '',
        path: '', hasPic: false, remote: true, base,
      }, base);
      tracks.set(t.id, t);
      if (al) al.tracks.push(t);
    }
    // a track that played keeps its object (the player and the engine hold it)
    for (const [id, t] of tracks) { const old = this.tracks.get(id); if (old && old.path) { Object.assign(old, t, { path: old.path, codec: old.codec, sampleRate: old.sampleRate, bits: old.bits }); tracks.set(id, old); const al = albums.get(old.albumId); if (al) al.tracks[al.tracks.indexOf(t)] = old; } }
    this.raw = buf; this.albums = albums; this.tracks = tracks;
  }

  getTrack(id) { return id ? this.tracks.get(id) || null : null; }
  getAlbum(id) { return id ? this.albums.get(id) || null : null; }

  /** The library.json the page reads while the PC's library is shown (the last one fetched, also without a connection). */
  json() { return this.raw; }

  // ───────────── talking to the PC ─────────────
  url(p) { return this.cfg.url.replace(/\/+$/, '') + p; }
  async req(p, opts = {}, ms = 15000) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    if (opts.signal) opts.signal.addEventListener('abort', () => ac.abort(), { once: true });
    try {
      const headers = Object.assign({}, opts.headers || {});
      if (this.cfg.token) headers['X-Miku-Token'] = this.cfg.token;
      if (opts.body) headers['Content-Type'] = 'application/json';
      const res = await fetch(this.url(p), { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined, signal: ac.signal });
      if (res.status === 401 && this.cfg.token && !p.startsWith('/api/pair')) this.unauthorized();
      return res;
    } catch (e) {
      if (ac.signal.aborted && !(opts.signal && opts.signal.aborted)) throw new Error('連不上遠端電腦（逾時）');
      throw new Error('連不上遠端電腦：' + (e.cause && e.cause.code || e.message));
    } finally { clearTimeout(timer); }
  }

  unauthorized() {
    // the PC forgot this Mac (取消配對 there): pair again
    this.cfg.token = ''; this.cfg.active = false; this.lastError = '另一台電腦的 MIKU 已取消這台電腦的配對，請重新配對。';
    this.stopEvents(); this.emit('changed'); this.emit('library'); this.emit('save');
  }

  static normalize(u) {
    u = String(u || '').trim();
    if (!u) throw new Error('請輸入另一台 MIKU 的網址');
    if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
    const x = new URL(u);
    if (!x.port) x.port = '8765';
    return x.origin;
  }

  /** Step 1: the PC shows a pairing code. */
  async pairStart(u) {
    const url = RemoteLibrary.normalize(u);
    const old = this.cfg.url;
    this.cfg.url = url; this.cfg.token = '';
    try {
      const ping = await this.req('/api/ping', {}, 8000);
      const j = await ping.json().catch(() => null);
      if (!j || j.app !== 'MIKU') throw new Error('這個網址不是 MIKU，請確認網址和連接埠');
      const r = await this.req('/api/pair/request', { method: 'POST', body: { name: this.deviceName() } }, 8000);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).e || '配對要求失敗（' + r.status + '）');
      this.pairing = true; this.lastError = '';
      this.emit('save'); this.emit('changed');
      return { ok: true };
    } catch (e) { if (!this.cfg.token) this.cfg.url = old || url; throw e; }
  }

  /** Step 2: the code read off the PC's screen. */
  async pairConfirm(code) {
    const r = await this.req('/api/pair/confirm', { method: 'POST', body: { code: String(code || '').trim(), name: this.deviceName() } }, 8000);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.token) throw new Error(j.e || '配對失敗');
    this.cfg.token = j.token; this.cfg.active = true; this.pairing = false; this.lastError = '';
    this.emit('save');
    await this.refresh();
    return this.info();
  }

  unpair() {
    this.stopEvents();
    Object.assign(this.cfg, { token: '', active: false, name: '' });
    this.pairing = false; this.online = false;
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

  /** Fetches the PC's library.json (kept on disk: the library is still listed without a connection). */
  async refresh() {
    if (!this.paired) return false;
    try {
      const r = await this.req('/media/library.json', {}, 60000);
      if (!r.ok) throw new Error('讀取音樂庫失敗（' + r.status + '）');
      const buf = Buffer.from(await r.arrayBuffer());
      const same = this.raw && this.raw.equals(buf);
      if (!same) { this.parse(buf); await fsp.writeFile(LibFile + '.tmp', buf); await fsp.rename(LibFile + '.tmp', LibFile); }
      this.online = true; this.lastError = '';
      this.emit('changed');
      if (!same && this.cfg.active) this.emit('library');
      if (this.cfg.active) this.startEvents();
      return true;
    } catch (e) {
      this.online = false; this.lastError = e.message;
      Log.error('Remote library refresh', e);
      this.emit('changed');
      return false;
    }
  }

  /** The PC's state events: its library changed (refetch it), and whether it can be reached. */
  startEvents() {
    if (this.events || !this.paired) return;
    const run = this.events = { stop: false, ac: null };
    (async () => {
      let wait = 3000;
      while (!run.stop && this.paired) {
        try {
          run.ac = new AbortController();
          const res = await fetch(this.url('/api/events'), { headers: { 'X-Miku-Token': this.cfg.token, Accept: 'text/event-stream' }, signal: run.ac.signal });
          if (res.status === 401) { this.unauthorized(); break; }
          if (!res.ok || !res.body) throw new Error('events ' + res.status);
          if (!this.online) { this.online = true; this.lastError = ''; this.emit('changed'); this.refresh().catch(() => { }); }
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
                if (m.ev === 'library') { clearTimeout(libTimer); libTimer = setTimeout(() => this.refresh().catch(() => { }), 2500); }
              } catch { }
            }
          }
        } catch (e) { if (run.stop) break; }
        if (run.stop) break;
        if (this.online) { this.online = false; this.emit('changed'); }
        await sleep(wait); wait = Math.min(wait * 2, 60000);
      }
    })();
  }
  stopEvents() { if (this.events) { this.events.stop = true; try { this.events.ac && this.events.ac.abort(); } catch { } this.events = null; } }

  // ───────────── covers ─────────────
  /** A cover from the PC (/art/a/…, /art/t/…, /art/r/…), cached on disk; null when it has none or can't be reached. */
  async art(p, size) {
    const file = path.join(ArtDir, hash(p + '@' + size) + '.jpg');
    try { return await fsp.readFile(file); } catch { }
    if (!this.paired) return null;
    this.missing = this.missing || new Map();
    const miss = this.missing.get(file);
    if (miss && Date.now() - miss < 10 * 60000) return null;
    try {
      const r = await this.req('/media' + p + '?s=' + size, {}, 20000);
      if (!r.ok) { this.missing.set(file, Date.now()); return null; }
      const buf = Buffer.from(await r.arrayBuffer());
      fsp.writeFile(file, buf).catch(() => { });
      return buf;
    } catch { this.missing.set(file, Date.now()); return null; }
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
    return this.url('/stream/' + encodeURIComponent(t.id) + '?' + (q === 'orig' ? 'raw=1' : `q=${q}&c=${Caps}`) + '&t=' + encodeURIComponent(this.cfg.token));
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
    if (this.paired && this.online) { this.bindStream(t); this.prefetch([t]); return true; }
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
      if (!this.paired) throw new Error('還沒有和遠端電腦配對');
      if (!this.online) {
        try { const r = await this.req('/api/ping', {}, 4000); if (!r.ok) throw new Error(); this.online = true; this.emit('changed'); }
        catch { throw new Error('連不上遠端電腦，這首歌還沒下載到這台電腦'); }
      }
      this.bindStream(t);
    }
    this.prefetch(next.filter(n => n && n.remote));
  }

  /** Copies the given songs into the cache, one after another (the song playing keeps most of the connection). */
  prefetch(list) {
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
    if (!this.paired) return Promise.reject(new Error('還沒有和遠端電腦配對'));
    // a song that just failed (no connection) is not asked for again at once by the gapless look-ahead
    this.failed = this.failed || new Map();
    if (!now && Date.now() - (this.failed.get(key) || 0) < 60000) return Promise.reject(new Error('稍後再試'));
    const job = { got: 0, total: 0, ac: new AbortController(), title: t.title };
    job.promise = (async () => {
      await fsp.mkdir(CacheDir, { recursive: true });
      const qs = q === 'orig' ? 'raw=1' : `q=${q}&c=${Caps}`;
      let res;
      for (let attempt = 0; ; attempt++) {
        res = await this.req('/stream/' + encodeURIComponent(t.id) + '?' + qs, { signal: job.ac.signal }, now ? 20000 : 60000);
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
    const dest = path.join(OfflineDir, path.basename(f.file));
    try { fs.renameSync(f.file, dest); f.file = dest; f.pin = true; }
    catch { try { fs.copyFileSync(f.file, dest); fs.unlinkSync(f.file); f.file = dest; f.pin = true; } catch (e) { Log.error('Remote pin', e); } }
    this.saveIndex();
  }

  /** How far the track that is about to play has come (shown while it loads). */
  progress(id) {
    for (const [k, j] of this.jobs) if (k.startsWith(id + '|')) return { got: j.got, total: j.total };
    return null;
  }

  saveIndex() { clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => { try { Json.saveAtomic(IndexFile, this.files); } catch (e) { Log.error('Remote index', e); } }, 1000); }

  /** Keeps the cache of played songs under its size (the oldest go first; offline albums and the playing song stay). */
  trim() {
    const limit = Math.max(0.5, Number(this.cfg.cacheGB) || 5) * 1024 ** 3;
    const list = Object.entries(this.files).filter(([, f]) => !f.pin).sort((a, b) => a[1].used - b[1].used);
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
  /** Keeps a whole album on this Mac (originals), one song at a time in the background. */
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
        try { await this.fetch(t, true, 'orig'); this.pin(t.id); this.offlineDone++; }
        catch (e) {
          this.lastError = `「${t.title}」下載失敗：${e.message}`;
          if (!this.online && /連不上/.test(e.message)) { this.offlineQueue.length = 0; break; }
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
      url: this.cfg.url, paired: this.paired, pairing: this.pairing, active: this.active, online: this.online, error: this.lastError,
      albums: this.albums.size, tracks: this.tracks.size, quality: this.cfg.quality || 'orig', cacheGB: this.cfg.cacheGB || 5,
      cacheBytes: cache, offlineBytes: offline, offline: [...offAlbums.values()].sort((a, b) => a.title.localeCompare(b.title)),
      offlineIds: [...ids], downloading: this.offlineQueue.length ? { done: this.offlineDone, total: this.offlineTotal, title: this.offlineQueue[0].title } : null,
    };
  }

  dispose() { this.stopEvents(); for (const j of this.jobs.values()) try { j.ac.abort(); } catch { } try { Json.saveAtomic(IndexFile, this.files); } catch { } }
}

module.exports = { RemoteLibrary };

'use strict';
// Music library: folder walking, tag reading (ffprobe), album grouping, compact export (port of Library.cs)
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { AppPaths, Log, Json, hash, norm, msToTicks } = require('./common');
const ff = require('./ffmpeg');

const Extensions = new Set(['.flac', '.wav', '.mp3', '.m4a', '.aac', '.alac', '.aif', '.aiff', '.aifc', '.ogg', '.oga', '.opus',
  '.wma', '.ape', '.wv', '.dsf', '.dff', '.tak', '.tta', '.mka', '.mp2', '.caf']);
const ArtNames = ['cover', 'folder', 'front', 'albumart', 'album', 'artwork', 'jacket', 'albumartsmall'];
const DiscFolder = /^(cd|disc|disk|dvd)\s*[-_.]?\s*\d+\b.*$/i;
const LeadingNumber = /^\s*(\d{1,3})\s*[-_. ]\s*(.+)$/;
const ImageExt = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const isDsd = t => t.codec === 'DSF' || t.codec === 'DFF';
const isLossy = t => ['MP3', 'AAC', 'OGG', 'OPUS', 'WMA', 'YouTube'].includes(t.codec);
const lc = s => (s || '').toLowerCase();

function codecFromExt(ext) {
  return ({
    '.flac': 'FLAC', '.wav': 'WAV', '.mp3': 'MP3', '.m4a': 'AAC', '.aac': 'AAC', '.alac': 'ALAC', '.aif': 'AIFF', '.aiff': 'AIFF', '.aifc': 'AIFF',
    '.ogg': 'OGG', '.oga': 'OGG', '.opus': 'OPUS', '.wma': 'WMA', '.ape': 'APE', '.wv': 'WavPack', '.dsf': 'DSF', '.dff': 'DFF', '.tak': 'TAK', '.tta': 'TTA',
  })[ext] || ext.replace('.', '').toUpperCase();
}

function albumFolder(p) {
  let dir = path.dirname(p);
  if (DiscFolder.test(path.basename(dir))) dir = path.dirname(dir);
  return dir;
}

/**
 * Discs of one album in sibling folders whose names don't say "Disc 2", found from the tags: folders under the same
 * parent holding the same album title and album artist, each with its own disc numbers (none shared). Returns
 * folder (lower case) → the parent folder to group them under. (Library.cs DiscSiblings)
 */
function discSiblings(tracks) {
  const merge = new Map(), groups = new Map();
  for (const t of tracks) {
    if (!t || !t.path || !t.album || !t.album.trim()) continue;
    const dir = path.dirname(t.path);
    if (lc(albumFolder(t.path)) !== lc(dir)) continue;   // a "Disc 2" folder already
    const key = lc(path.dirname(dir)) + '|' + norm(t.album) + '|' + norm(t.albumArtist || '');
    let g = groups.get(key); if (!g) groups.set(key, g = new Map());
    let f = g.get(lc(dir)); if (!f) g.set(lc(dir), f = { dir, discs: new Set() });
    f.discs.add(t.discNo);
  }
  for (const g of groups.values()) {
    if (g.size < 2) continue;
    const folders = [...g.values()];
    const parent = path.dirname(folders[0].dir);
    if (!parent || parent === '/' ) continue;
    const discs = folders.flatMap(f => [...f.discs]);
    if (new Set(discs).size !== discs.length) continue;   // a disc number in two folders: separate albums
    for (const f of folders) merge.set(lc(f.dir), parent);
  }
  return merge;
}

/**
 * The same album in several folders / formats (Library.cs GroupVersions): same title, same album artist or folders
 * near each other, and the same music (track lengths). Marked with a common versionGroup.
 */
function groupVersions(all) {
  const buckets = new Map();
  for (const a of all) { a.versionGroup = null; if (a.loose) continue; const k = norm(a.title); (buckets.get(k) || buckets.set(k, []).get(k)).push(a); }
  const compilation = s => s === 'Various Artists' || s === '未知演出者' || !s || !s.trim();
  const near = (x, y) => {
    const p = x.split(path.sep).filter(Boolean), q = y.split(path.sep).filter(Boolean);
    let c = 0;
    while (c < p.length && c < q.length && lc(p[c]) === lc(q[c])) c++;
    return c >= 2 && p.length - c <= 2 && q.length - c <= 2;
  };
  const sameTitle = (a, b) => { const p = norm(a, true), q = norm(b, true); return p.length > 0 && q.length > 0 && (p === q || (Math.min(p.length, q.length) >= 2 && (p.includes(q) || q.includes(p)))); };
  const sameMusic = (x, y) => {
    const [small, large] = x.tracks.length <= y.tracks.length ? [x, y] : [y, x];
    const pool = large.tracks.filter(t => t.duration > 0);
    let hits = 0;
    for (const t of small.tracks.filter(t => t.duration > 0)) {
      const d = t.duration;
      let k = pool.findIndex(p => Math.abs(p.duration - d) <= 0.5);
      if (k < 0) k = pool.findIndex(p => Math.abs(p.duration - d) <= 2.0 && sameTitle(p.title, t.title));
      if (k >= 0) { hits++; pool.splice(k, 1); }
    }
    return hits > 0 && hits * 2 >= small.tracks.length;
  };
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    const parent = new Map(list.map(a => [a, a]));
    const find = a => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const x = list[i], y = list[j];
        const sameArtist = !compilation(x.artist) && norm(x.artist) === norm(y.artist);
        if ((sameArtist || near(x.folder, y.folder)) && sameMusic(x, y)) parent.set(find(x), find(y));
      }
    const groups = new Map();
    for (const a of list) { const r = find(a); (groups.get(r) || groups.set(r, []).get(r)).push(a); }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const id = hash('versions|' + g.map(a => a.id).sort().join('|'));
      for (const a of g) a.versionGroup = id;
    }
  }
}

class MusicLibrary extends EventEmitter {
  constructor(settings) {
    super();
    this.s = settings;
    this.byId = new Map();
    this.albums = new Map();
    this.folderArt = {};
    this.revision = 0;
    this.progress = { scanning: false, found: 0, done: 0, failed: 0 };
    this.scanToken = 0;
    this.playbackActive = () => false;
    this.savePending = null;
    this.saveRunning = false;
    this.saveQueue = Promise.resolve();
  }
  getTrack(id) { return id ? this.byId.get(id) || null : null; }
  getAlbum(id) { return id ? this.albums.get(id) || null : null; }
  get allTracks() { return [...this.byId.values()]; }
  get count() { return this.byId.size; }
  albumList() { return [...this.albums.values()]; }

  load() {
    const cache = Json.load(AppPaths.Library, { tracks: [], folderArt: {} });
    const tracks = cache.tracks || [], migrationTime = msToTicks(Date.now());
    // Old caches only have modification times: freeze that historical order once.
    let migrated = false;
    for (const t of tracks) if (t && !(t.added > 0)) {
      t.added = t.mtime > 0 ? Math.min(t.mtime, migrationTime) : migrationTime;
      migrated = true;
    }
    this.build(tracks, cache.folderArt || {});
    if (migrated) this.save(tracks);
  }
  save(tracks) {
    // A scan can publish another snapshot while the previous write is still running.
    // Retain only the newest waiting snapshot so RAM and disk work stay bounded.
    this.savePending = { version: 1, tracks: tracks.slice(), folderArt: { ...this.folderArt } };
    if (!this.saveRunning) {
      this.saveRunning = true;
      this.saveQueue = new Promise(resolve => setImmediate(resolve)).then(() => this.flushSaves());
    }
    return this.saveQueue;
  }
  async flushSaves() {
    try {
      while (this.savePending) {
        const snapshot = this.savePending;
        this.savePending = null;
        try {
          const tmp = AppPaths.Library + '.tmp';
          await fs.promises.writeFile(tmp, JSON.stringify(snapshot));
          await fs.promises.rename(tmp, AppPaths.Library);
        } catch (e) { Log.error('Save library', e); }
      }
    } finally { this.saveRunning = false; }
  }

  build(tracks, folderArt) {
    const albums = new Map(), byId = new Map();
    const siblings = discSiblings(tracks);
    for (const t of tracks) {
      if (!t || !t.path) continue;
      t.id = t.id || hash(t.path.toLowerCase());
      byId.set(t.id, t);
      let folder = albumFolder(t.path);
      if (siblings.has(lc(folder))) folder = siblings.get(lc(folder));
      const loose = !t.album || !t.album.trim();
      const title = loose ? path.basename(folder) : t.album.trim();
      const id = hash(folder.toLowerCase() + '|' + norm(title));
      let a = albums.get(id);
      if (!a) { a = { id, title: title && title.trim() ? title : '未知專輯', folder, loose, tracks: [], artPath: null }; albums.set(id, a); }
      t.albumId = id;
      a.tracks.push(t);
    }
    const perFolder = new Map();
    for (const a of albums.values()) perFolder.set(lc(a.folder), (perFolder.get(lc(a.folder)) || 0) + 1);
    const fa = new Map(Object.entries(folderArt).map(([k, v]) => [lc(k), v]));
    for (const a of albums.values()) {
      a.tracks.sort((x, y) => (x.discNo - y.discNo) || (x.trackNo - y.trackNo) || path.basename(x.path).localeCompare(path.basename(y.path), undefined, { sensitivity: 'base' }));
      const count = arr => { const m = new Map(); for (const s of arr) m.set(s, (m.get(s) || 0) + 1); return [...m.entries()].sort((p, q) => q[1] - p[1]); };
      let artist = (count(a.tracks.map(t => t.albumArtist).filter(s => s && s.trim()))[0] || [])[0];
      if (!artist) {
        const artists = [...new Map(a.tracks.map(t => t.artist).filter(s => s && s.trim()).map(s => [s.toLowerCase(), s])).values()];
        artist = artists.length === 1 ? artists[0] : artists.length === 0 ? '未知演出者' : (a.loose ? count(a.tracks.map(t => t.artist).filter(Boolean))[0][0] : 'Various Artists');
      }
      a.artist = artist;
      const years = a.tracks.map(t => t.year).filter(y => y > 0);
      a.year = years.length ? Math.min(...years) : 0;
      a.genre = (a.tracks.find(t => t.genre && t.genre.trim()) || {}).genre || '';
      a.added = Math.max(...a.tracks.map(t => t.added || 0));
      const n = perFolder.get(lc(a.folder)) || 0;
      if (n === 1 && fa.has(lc(a.folder))) a.artPath = fa.get(lc(a.folder));
      else { const d = lc(path.dirname(a.tracks[0].path)); if (n === 1 && fa.has(d)) a.artPath = fa.get(d); }
    }
    groupVersions(albums.values());
    this.byId = byId; this.albums = albums; this.folderArt = folderArt; this.revision++;
  }

  // ───────────── scanning ─────────────
  startScan(full = false) {
    const token = ++this.scanToken;
    this.scan(full, token).catch(e => Log.error('Scan', e));
  }
  report(p) { this.progress = { ...p }; this.emit('progress', this.progress); }

  async scan(full, token) {
    const p = { scanning: true, found: 0, done: 0, failed: 0 };
    this.report(p);
    const cancelled = () => token !== this.scanToken;
    try {
      const existing = new Map([...this.byId.values()].map(t => [lc(t.path), t]));
      const addedAt = msToTicks(Date.now());
      const files = [], folderArt = {}, offline = [];
      for (const root of [...(this.s.folders || [])]) {
        if (!fs.existsSync(root)) { offline.push(root); continue; }
        await this.walk(root, files, folderArt, p, cancelled);
        if (cancelled()) return;
      }
      p.found = files.length; this.report(p);
      const result = [], todo = [];
      for (const f of files) {
        const old = existing.get(lc(f.path));
        if (!full && old && old.size === f.size && old.mtime === f.mtime) result.push(old); else todo.push(f);
      }
      for (const t of existing.values()) if (offline.some(r => lc(t.path).startsWith(lc(r)))) result.push(t);
      p.done = result.length; this.report(p);
      let lastReport = Date.now(), lastPublish = Date.now(), idx = 0;
      const worker = async lane => {
        while (idx < todo.length && !cancelled()) {
          // Keep tag probes from competing with playback for CPU and disk bandwidth.
          if (lane >= 2 && this.playbackActive()) { await new Promise(r => setTimeout(r, 250)); continue; }
          const f = todo[idx++];
          const t = await readTrack(f);
          if (cancelled()) return;
          if (t) {
            t.added = existing.get(lc(f.path))?.added || addedAt;
            result.push(t);
          } else p.failed++;
          if (Date.now() - lastPublish > 15000) {
            lastPublish = Date.now();
            const snapshot = result.slice();
            this.build(snapshot, folderArt); this.save(snapshot); this.emit('changed');
          }
          if (Date.now() - lastReport > 250) { lastReport = Date.now(); p.done = result.length; p.current = path.basename(f.path); this.report(p); }
        }
      };
      const n = Math.max(2, Math.min(4, Math.floor(require('os').cpus().length / 2)));
      await Promise.all(Array.from({ length: n }, (_, lane) => worker(lane)));
      if (cancelled()) return;
      const changed = todo.length > 0 || result.length !== existing.size;
      if (changed || full || JSON.stringify(folderArt) !== JSON.stringify(this.folderArt)) {
        this.build(result, folderArt); await this.save(result); this.emit('changed');
        // files read again that were already known: thumbnails made from their old pictures are stale
        const again = new Set(todo.filter(f => existing.has(lc(f.path))).map(f => lc(f.path)));
        if (again.size) this.emit('tracksRead', result.filter(t => again.has(lc(t.path))));
      }
      p.done = result.length;
    } catch (e) { Log.error('Scan', e); }
    finally {
      if (!cancelled()) { p.scanning = false; delete p.current; this.report(p); }
    }
  }

  async walk(dir, files, folderArt, p, cancelled) {
    if (cancelled()) return;
    const subs = await this.scanFolder(dir, files, folderArt);
    if (!subs) return;
    if (files.length - p.found > 500) { p.found = files.length; this.report(p); }
    for (const s of subs) await this.walk(s, files, folderArt, p, cancelled);
  }

  /** The audio files of one folder (not its subfolders) and its album picture; returns the subfolders, null when unreadable. */
  async scanFolder(dir, files, folderArt) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return null; }
    let bestArt = null, bestRank = Infinity, bestSize = 0;
    const images = [], subs = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { subs.push(full); continue; }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (Extensions.has(ext)) {
        try { const st = await fs.promises.stat(full); files.push({ path: full, size: st.size, mtime: msToTicks(st.mtimeMs), ext }); } catch { }
        continue;
      }
      if (ImageExt.has(ext)) {
        let size = 0; try { size = (await fs.promises.stat(full)).size; } catch { }
        images.push({ full, size });
        const stem = path.basename(e.name, path.extname(e.name)).toLowerCase();
        let rank = ArtNames.findIndex(n => stem === n || stem.startsWith(n + ' ') || stem.startsWith(n + '_') || stem.startsWith(n + '-') || stem.startsWith(n + '.'));
        if (rank < 0 && stem.includes('cover')) rank = 20;
        if (rank >= 0 && (rank < bestRank || (rank === bestRank && size > bestSize))) { bestRank = rank; bestArt = full; bestSize = size; }
      }
    }
    if (!bestArt && images.length === 1 && images[0].size > 15000) bestArt = images[0].full;
    if (bestArt) folderArt[dir] = bestArt;
    return subs;
  }

  /**
   * Read the tags of one album again (album menu, after the tag editor): every audio file in the folders holding its
   * tracks, and the folder pictures. `moved`: old path → new path of renamed files. Returns { albumId, tracks }.
   */
  async rereadAlbum(albumId, moved = null) {
    if (this.progress.scanning) throw new Error('媒體庫正在掃描，請等掃描完成後再試');
    const album = this.getAlbum(albumId);
    if (!album) throw new Error('找不到這張專輯');
    const paths = album.tracks.map(t => t.path);
    const existing = new Map([...this.byId.values()].map(t => [lc(t.path), t]));
    for (const [oldPath, newPath] of Object.entries(moved || {})) {
      const old = existing.get(lc(oldPath));
      if (old) existing.set(lc(newPath), old);
    }
    const addedAt = msToTicks(Date.now());
    const dirs = new Set(paths.map(p => lc(path.dirname(p))));
    const dirList = [...new Map(paths.map(p => [lc(path.dirname(p)), path.dirname(p)])).values()];
    const files = [], art = {};
    for (const d of dirList) await this.scanFolder(d, files, art);
    const seen = new Set(), fresh = [];
    const uniq = files.filter(f => !seen.has(lc(f.path)) && seen.add(lc(f.path)));
    let i = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (i < uniq.length) {
        const f = uniq[i++], t = await readTrack(f);
        if (t) {
          t.added = existing.get(lc(f.path))?.added || addedAt;
          fresh.push(t);
        }
      }
    }));
    const list = [...this.byId.values()].filter(t => !dirs.has(lc(path.dirname(t.path)))).concat(fresh);
    const folderArt = Object.fromEntries(Object.entries(this.folderArt).filter(([d]) => !dirs.has(lc(d))));
    Object.assign(folderArt, art);
    this.build(list, folderArt);
    await this.save(list);
    this.emit('changed');
    this.emit('tracksRead', fresh);
    const movedLc = new Map(Object.entries(moved || {}).map(([k, v]) => [lc(k), v]));
    const counts = new Map();
    for (const p of paths) {
      const np = movedLc.get(lc(p)) || p;
      const t = this.getTrack(hash(np.toLowerCase()));
      if (t) counts.set(t.albumId, (counts.get(t.albumId) || 0) + 1);
    }
    const newId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    return { albumId: newId, tracks: newId ? (this.getAlbum(newId)?.tracks.length || 0) : 0 };
  }

  /** Compact JSON: arrays instead of objects keep 30k+ tracks small and fast to parse. */
  exportJson() {
    // the library only changes in build() (which raises the revision): the same revision is the same JSON
    if (this.exported && this.exported.revision === this.revision) return this.exported.data;
    const albums = [], tracks = [];
    for (const a of this.albums.values()) {
      // [id, title, artist, year, genre, added, hasLocalArt, loose, versionGroup, folderName]
      albums.push([a.id, a.title, a.artist, a.year, a.genre, a.added / 1e7, (a.artPath || a.tracks.some(t => t.hasPic)) ? 1 : 0, a.loose ? 1 : 0, a.versionGroup || '', path.basename(a.folder || '')]);
      // Track import time is independent of the newest song in its album.
      for (const t of a.tracks) tracks.push([t.id, t.title, t.artist, a.id, t.discNo, t.trackNo, Math.round(t.duration * 100) / 100, t.codec, t.sampleRate, t.bits, t.year, t.composer || '', t.added / 1e7]);
    }
    const data = Buffer.from(JSON.stringify({ revision: this.revision, albums, tracks }));
    this.exported = { revision: this.revision, data };
    return data;
  }
}

function dsfHeader(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(80);
    fs.readSync(fd, b, 0, 80, 0);
    fs.closeSync(fd);
    if (b.toString('ascii', 0, 4) !== 'DSD ' || b.toString('ascii', 28, 32) !== 'fmt ') return null;
    const channels = b.readUInt32LE(52), rate = b.readUInt32LE(56);
    const samples = Number(b.readBigUInt64LE(64));
    return { channels, rate, duration: rate ? samples / rate : 0 };
  } catch { return null; }
}

/**
 * DFF: ffprobe does not read the "ID3 " chunk (where foobar2000 / JRiver / TagLib, and MIKU's tag editor, put the
 * tags), so its text frames are read here. Returns { title, artist, … } with only the fields the tag has.
 */
function dffTags(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const st = fs.fstatSync(fd);
      const head = Buffer.alloc(16);
      if (fs.readSync(fd, head, 0, 16, 0) !== 16 || head.toString('latin1', 0, 4) !== 'FRM8') return null;
      const end = Math.min(st.size, 12 + Number(head.readBigInt64BE(4)));
      const c = Buffer.alloc(12);
      for (let pos = 16; pos + 12 <= end;) {
        fs.readSync(fd, c, 0, 12, pos);
        const size = Number(c.readBigInt64BE(4));
        if (c.toString('latin1', 0, 4) === 'ID3 ' && size > 10) {
          const buf = Buffer.alloc(Math.min(size, 64 * 1024 * 1024, st.size - pos - 12));
          fs.readSync(fd, buf, 0, buf.length, pos + 12);
          const tag = require('./tagwriter')._test.parseId3(buf);
          const text = d => {
            const enc = d[0], b = d.slice(1);
            let s = enc === 0 ? b.toString('latin1') : enc === 3 ? b.toString('utf8')
              : enc === 1 ? (b[0] === 0xFE && b[1] === 0xFF ? Buffer.from(b.slice(2)).swap16().toString('utf16le') : b.slice(b[0] === 0xFF && b[1] === 0xFE ? 2 : 0).toString('utf16le'))
              : Buffer.from(b.slice(0, b.length & ~1)).swap16().toString('utf16le');
            return s.replace(/\uFEFF/g, '').split('\0').map(x => x.trim()).filter(Boolean).join('; ');
          };
          const out = {}, map = { TIT2: 'title', TPE1: 'artist', TPE2: 'albumArtist', TALB: 'album', TCON: 'genre', TCOM: 'composer', TYER: 'year', TDRC: 'year', TRCK: 'track', TPOS: 'disc' };
          for (const fr of (tag && tag.frames) || []) {
            if (fr.id === 'APIC') { out.hasPic = true; continue; }
            const k = map[fr.id];
            if (k && !out[k] && fr.data && fr.data.length > 1) out[k] = text(fr.data);
          }
          return out;
        }
        if (size < 0) break;
        pos += 12 + size + (size & 1);
      }
      return null;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

async function readTrack(f) {
  const t = {
    path: f.path, id: hash(f.path.toLowerCase()), size: f.size, mtime: f.mtime, codec: codecFromExt(f.ext),
    title: '', artist: '', albumArtist: '', album: '', genre: '', composer: '', year: 0, trackNo: 0, discNo: 0,
    duration: 0, sampleRate: 0, bits: 0, channels: 2, bitrate: 0, hasPic: false,
  };
  let ok = false;
  try {
    const j = await ff.probe(f.path);
    const streams = j.streams || [];
    const a = streams.find(s => s.codec_type === 'audio');
    const fmt = j.format || {};
    const tags = {};
    for (const src of [...streams.map(s => s.tags || {}), fmt.tags || {}]) for (const k in src) tags[k.toLowerCase()] = src[k];
    const g = (...ks) => { for (const k of ks) if (tags[k] != null && String(tags[k]).trim()) return String(tags[k]).replace(/\0/g, ' ').trim(); return ''; };
    t.title = g('title');
    t.artist = g('artist', 'performer');
    t.albumArtist = g('album_artist', 'albumartist', 'album artist', 'tpe2');
    t.album = g('album');
    t.genre = g('genre');
    t.composer = g('composer');
    const y = /\d{4}/.exec(g('date', 'year', 'originaldate', 'tdrc'));
    t.year = y ? +y[0] : 0;
    t.trackNo = parseInt(g('track', 'tracknumber'), 10) || 0;
    t.discNo = parseInt(g('disc', 'discnumber'), 10) || 0;
    const rg = s => { const m = /[-+]?\d+(\.\d+)?/.exec(s || ''); return m ? parseFloat(m[0]) : null; };
    const rgt = rg(g('replaygain_track_gain')), rga = rg(g('replaygain_album_gain'));
    if (rgt) t.rgTrack = rgt;
    if (rga) t.rgAlbum = rga;
    t.duration = parseFloat(fmt.duration) || 0;
    t.hasPic = streams.some(s => s.codec_type === 'video' && s.disposition && s.disposition.attached_pic);
    if (a) {
      t.sampleRate = parseInt(a.sample_rate, 10) || 0;
      t.channels = a.channels || 2;
      t.bits = parseInt(a.bits_per_raw_sample, 10) || parseInt(a.bits_per_sample, 10) || 0;
      t.bitrate = Math.round((parseInt(a.bit_rate || fmt.bit_rate, 10) || 0) / 1000);
      const cn = a.codec_name || '';
      if (f.ext === '.m4a' || f.ext === '.mp4' || f.ext === '.caf') t.codec = cn === 'alac' ? 'ALAC' : cn === 'aac' ? 'AAC' : t.codec;
      if (['mp3', 'aac', 'vorbis', 'opus', 'wmav2', 'wmav1'].includes(cn)) t.bits = 0;
      if (cn.startsWith('pcm_f')) t.bits = t.bits || 32;
    }
    ok = true;
  } catch (e) { Log.info(`ffprobe failed ${f.path}: ${e.message}`); }
  if (t.codec === 'DSF') {
    const d = dsfHeader(f.path);
    if (d) { t.sampleRate = d.rate; t.channels = d.channels; t.duration = d.duration || t.duration; ok = true; }
  }
  if (t.codec === 'DFF') {
    const d = dffTags(f.path);
    if (d) {
      for (const k of ['title', 'artist', 'albumArtist', 'album', 'genre', 'composer']) if (d[k]) t[k] = d[k];
      const y = /\d{4}/.exec(d.year || ''); if (y) t.year = +y[0];
      if (parseInt(d.track, 10)) t.trackNo = parseInt(d.track, 10);
      if (parseInt(d.disc, 10)) t.discNo = parseInt(d.disc, 10);
      if (d.hasPic) t.hasPic = true;
    }
  }
  if (isDsd(t)) { t.bits = 1; if (t.sampleRate && t.sampleRate < 1e6) t.sampleRate *= 8; }
  if (!ok) return null;
  const stem = path.basename(f.path, path.extname(f.path));
  if (!t.title) {
    const m = LeadingNumber.exec(stem);
    if (m) { t.title = m[2].trim(); if (!t.trackNo) t.trackNo = +m[1]; } else t.title = stem;
  }
  if (!t.trackNo) { const m = LeadingNumber.exec(stem); if (m) t.trackNo = +m[1]; }
  if (!t.artist) t.artist = t.albumArtist || '';
  if (!t.discNo) t.discNo = 1;
  return t;
}

module.exports = { MusicLibrary, isDsd, isLossy, Extensions, readTrack };

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
  }
  getTrack(id) { return id ? this.byId.get(id) || null : null; }
  getAlbum(id) { return id ? this.albums.get(id) || null : null; }
  get count() { return this.byId.size; }
  albumList() { return [...this.albums.values()]; }

  load() {
    const cache = Json.load(AppPaths.Library, { tracks: [], folderArt: {} });
    this.build(cache.tracks || [], cache.folderArt || {});
  }
  save(tracks) {
    try { Json.saveAtomic(AppPaths.Library, { version: 1, tracks, folderArt: this.folderArt }); }
    catch (e) { Log.error('Save library', e); }
  }

  build(tracks, folderArt) {
    const albums = new Map(), byId = new Map();
    for (const t of tracks) {
      if (!t || !t.path) continue;
      t.id = t.id || hash(t.path.toLowerCase());
      byId.set(t.id, t);
      const folder = albumFolder(t.path);
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
      a.added = Math.max(...a.tracks.map(t => t.mtime || 0));
      const n = perFolder.get(lc(a.folder)) || 0;
      if (n === 1 && fa.has(lc(a.folder))) a.artPath = fa.get(lc(a.folder));
      else { const d = lc(path.dirname(a.tracks[0].path)); if (n === 1 && fa.has(d)) a.artPath = fa.get(d); }
    }
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
      const worker = async () => {
        while (idx < todo.length && !cancelled()) {
          const f = todo[idx++];
          const t = await readTrack(f);
          if (t) result.push(t); else p.failed++;
          if (Date.now() - lastPublish > 15000) {
            lastPublish = Date.now();
            this.build(result.slice(), folderArt); this.save(result.slice()); this.emit('changed');
          }
          if (Date.now() - lastReport > 250) { lastReport = Date.now(); p.done = result.length; p.current = path.basename(f.path); this.report(p); }
        }
      };
      const n = Math.max(2, Math.min(6, Math.floor(require('os').cpus().length / 2)));
      await Promise.all(Array.from({ length: n }, worker));
      if (cancelled()) return;
      const changed = todo.length > 0 || result.length !== existing.size;
      if (changed || full || JSON.stringify(folderArt) !== JSON.stringify(this.folderArt)) {
        this.build(result, folderArt); this.save(result); this.emit('changed');
      }
      p.done = result.length;
    } catch (e) { Log.error('Scan', e); }
    finally {
      if (!cancelled()) { p.scanning = false; delete p.current; this.report(p); }
    }
  }

  async walk(dir, files, folderArt, p, cancelled) {
    if (cancelled()) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
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
    if (files.length - p.found > 500) { p.found = files.length; this.report(p); }
    for (const s of subs) await this.walk(s, files, folderArt, p, cancelled);
  }

  /** Compact JSON: arrays instead of objects keep 30k+ tracks small and fast to parse. */
  exportJson() {
    const albums = [], tracks = [];
    for (const a of this.albums.values()) {
      albums.push([a.id, a.title, a.artist, a.year, a.genre, Math.floor(a.added / 1e7), (a.artPath || a.tracks.some(t => t.hasPic)) ? 1 : 0, a.loose ? 1 : 0]);
      for (const t of a.tracks) tracks.push([t.id, t.title, t.artist, a.id, t.discNo, t.trackNo, Math.round(t.duration * 100) / 100, t.codec, t.sampleRate, t.bits, t.year, t.composer || '']);
    }
    return Buffer.from(JSON.stringify({ revision: this.revision, albums, tracks }));
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

module.exports = { MusicLibrary, isDsd, isLossy, Extensions };

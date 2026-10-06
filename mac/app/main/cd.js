'use strict';
// ═════════════════════════════ audio CD on macOS: reading, playing, ripping (port of Library/Cd.cs) ═════════════════════════════
//
// macOS mounts an audio CD itself (cddafs): /Volumes/<name>/ holds one AIFF file per track and .TOC.plist, the disc's
// table of contents. A disc shows up as an album (id "cd-<MusicBrainz disc id>") that is not part of the library;
// main.js asks this module for ids the library doesn't know. Playing a track copies it from the disc into a WAV file in
// the cache (…/MIKU/CD/<disc>/NN.wav) as fast as the drive reads; playback starts once 20 s of it are there.
// Ripping: the track's samples (plus a margin from the tracks next to it) → read offset correction (found with
// AccurateRip when this drive's isn't known yet) → AccurateRip check → FFmpeg to the chosen format with the tags.
// macOS reads the disc through its own cache, so sectors can't be forced to be read again as on Windows: AccurateRip
// is what tells whether a rip is exact.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const { AppPaths, Log, http, RateGate } = require('./common');
const Converter = require('./converter');
const ff = require('./ffmpeg');

const SectorBytes = 2352;
const SamplesPerSector = 588;
const run = (cmd, args) => new Promise(res => execFile(cmd, args, { timeout: 15000 }, (e, out) => res(e ? '' : String(out || ''))));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hex = (n, w) => (n >>> 0).toString(16).toUpperCase().padStart(w, '0');
const safe = id => id.replace(/[^A-Za-z0-9]/g, '_');

// ───────────── .TOC.plist (a small XML property-list reader) ─────────────
function parsePlist(xml) {
  const re = /<(\/?)(dict|array|key|string|integer|real|true|false|data|date)(\s*\/)?>([^<]*)/g;
  const stack = [];
  let root, key = null, m;
  const put = v => {
    const top = stack[stack.length - 1];
    if (!top) { root = v; return; }
    if (Array.isArray(top)) top.push(v); else { top[key] = v; key = null; }
  };
  while ((m = re.exec(xml))) {
    const [, close, tag, selfClose, text] = m;
    if (tag === 'dict' || tag === 'array') {
      if (close) { const v = stack.pop(); if (!stack.length) root = v; }
      else if (selfClose) put(tag === 'dict' ? {} : []);
      else { const v = tag === 'dict' ? {} : []; put(v); stack.push(v); }
      continue;
    }
    if (close) continue;
    switch (tag) {
      case 'key': key = text; break;
      case 'string': put(text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')); break;
      case 'integer': put(parseInt(text, 10)); break;
      case 'real': put(parseFloat(text)); break;
      case 'true': put(true); break;
      case 'false': put(false); break;
      default: put(text.trim());
    }
  }
  return root;
}

/** The table of contents from cddafs' .TOC.plist; LBAs as Windows reads them (the first track's audio at 0, not 150). */
function readToc(volume) {
  const p = parsePlist(fs.readFileSync(path.join(volume, '.TOC.plist'), 'utf8'));
  const sessions = (p && p.Sessions) || [];
  const tracks = [];
  let leadout = 0;
  for (const s of sessions) {
    for (const t of s['Track Array'] || []) tracks.push({ no: t.Point, lba: t['Start Block'], audio: !t.Data, session: t['Session Number'] || s['Session Number'] || 1 });
    leadout = Math.max(leadout, s['Leadout Block'] || 0);
  }
  tracks.sort((a, b) => a.no - b.no);
  if (!tracks.length || !leadout) throw new Error('光碟目錄不完整');
  // cddafs counts from the start of the lead-in's 2-second pause (the first track at 150); MusicBrainz / AccurateRip
  // add those 150 again, so take them off
  const base = tracks[0].lba >= 150 ? 150 : 0;
  for (const t of tracks) t.lba -= base;
  return new Toc(tracks, leadout - base);
}

class Toc {
  constructor(tracks, leadout) { this.tracks = tracks; this.leadout = leadout; }
  get audio() { return this.tracks.filter(t => t.audio); }
  /** End of the audio: an Enhanced CD's data session starts 11400 sectors after the audio session ends. */
  get audioLeadout() {
    const a = this.audio;
    if (!a.length) return this.leadout;
    const data = this.tracks.find(t => !t.audio && t.no > a[a.length - 1].no);
    return data ? data.lba - 11400 : this.leadout;
  }
  endOf(t) { const a = this.audio, i = a.indexOf(t); return i + 1 < a.length ? a[i + 1].lba : this.audioLeadout; }
  get key() { return this.tracks.map(t => t.lba).join(',') + '/' + this.leadout; }
  musicBrainzId() {
    const a = this.audio;
    let s = hex(a[0].no, 2) + hex(a[a.length - 1].no, 2) + hex(this.audioLeadout + 150, 8);
    for (let i = 1; i < 100; i++) { const t = a.find(x => x.no === i); s += hex(t ? t.lba + 150 : 0, 8); }
    return crypto.createHash('sha1').update(s, 'ascii').digest('base64').replace(/\+/g, '.').replace(/\//g, '_').replace(/=/g, '-');
  }
  musicBrainzToc() { const a = this.audio; return [a[0].no, a[a.length - 1].no, this.audioLeadout + 150, ...a.map(t => t.lba + 150)].join('+'); }
  freedbId() {
    const digits = n => { let s = 0; while (n > 0) { s += n % 10; n = Math.floor(n / 10); } return s; };
    let n = 0;
    for (const t of this.tracks) n += digits(Math.floor((t.lba + 150) / 75));
    const len = Math.floor((this.leadout + 150) / 75) - Math.floor((this.tracks[0].lba + 150) / 75);
    return (((n % 255) << 24) | (len << 8) | this.tracks.length) >>> 0;
  }
  accurateRipIds() {
    const a = this.audio, lo = this.audioLeadout;
    let id1 = 0, id2 = 0;
    for (let i = 0; i < a.length; i++) { id1 = (id1 + a[i].lba) >>> 0; id2 = (id2 + Math.imul(Math.max(a[i].lba, 1), i + 1)) >>> 0; }
    id1 = (id1 + lo) >>> 0; id2 = (id2 + Math.imul(Math.max(lo, 1), a.length + 1)) >>> 0;
    return [id1, id2];
  }
}

// ───────────── the track files (AIFF, big-endian) ─────────────
/** Where the samples of an AIFF file are: { file, data (byte offset of the first sample), sectors }. */
function aiffInfo(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    if (head.toString('latin1', 0, 4) !== 'FORM') throw new Error('不是 AIFF 檔');
    const size = fs.fstatSync(fd).size;
    let o = 12;
    const ch = Buffer.alloc(16);
    while (o + 8 <= size) {
      fs.readSync(fd, ch, 0, 16, o);
      const id = ch.toString('latin1', 0, 4), len = ch.readUInt32BE(4);
      if (id === 'SSND') {
        const off = ch.readUInt32BE(8);
        const data = o + 16 + off, bytes = Math.min(len - 8 - off, size - data);
        return { file, data, sectors: Math.floor(bytes / SectorBytes) };
      }
      o += 8 + len + (len & 1);
    }
    throw new Error('AIFF 檔裡沒有聲音資料');
  } finally { fs.closeSync(fd); }
}

const swap16 = (buf, len) => { for (let k = 0; k + 1 < len; k += 2) { const x = buf[k]; buf[k] = buf[k + 1]; buf[k + 1] = x; } };

function wavHeader(dataBytes) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + dataBytes, 4); h.write('WAVEfmt ', 8, 'latin1');
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(44100, 24);
  h.writeUInt32LE(44100 * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36, 'latin1'); h.writeUInt32LE(dataBytes, 40);
  return h;
}

// ───────────── AccurateRip ─────────────
const AccurateRip = {
  async fetch(toc, signal) {
    const [id1, id2] = toc.accurateRipIds();
    const n = toc.audio.length;
    const h8 = v => (v >>> 0).toString(16).padStart(8, '0');
    const url = `http://www.accuraterip.com/accuraterip/${(id1 & 0xF).toString(16)}/${((id1 >> 4) & 0xF).toString(16)}/${((id1 >> 8) & 0xF).toString(16)}/dBAR-${String(n).padStart(3, '0')}-${h8(id1)}-${h8(id2)}-${h8(toc.freedbId())}.bin`;
    try {
      const res = await http(url, { timeout: 20000, signal });
      if (!res.ok) return null;
      const b = Buffer.from(await res.arrayBuffer());
      const tracks = Array.from({ length: n }, () => []);
      let o = 0;
      while (o + 13 <= b.length) {
        const count = b[o]; o += 13;
        for (let i = 0; i < count && o + 9 <= b.length; i++, o += 9) if (i < n) tracks[i].push({ conf: b[o], crc: b.readUInt32LE(o + 1) });
      }
      return tracks.some(t => t.length) ? { tracks } : null;
    } catch (e) { if (signal && signal.aborted) throw e; Log.info('AccurateRip lookup: ' + e.message); return null; }
  },
};

/** v1 / v2 checksums of a track (stereo 16-bit as one 32-bit word each); the first / last track skip 5 sectors. */
class Summer {
  constructor(total, first, last) { this.i = 0; this.from = first ? 5 * SamplesPerSector - 1 : 0; this.to = last ? total - 5 * SamplesPerSector : total; this.v1 = 0; this.v2 = 0; }
  add(buf, len) {
    let i = this.i, v1 = this.v1, v2 = this.v2;
    const from = this.from, to = this.to;
    for (let k = 0; k + 4 <= len; k += 4, i++) {
      if (i < from || i >= to) continue;
      const v = buf.readUInt32LE(k), m = i + 1;
      v1 = (v1 + Math.imul(v, m)) >>> 0;
      // v × m as 64 bits: high word + low word
      const ml = m & 0xFFFF, mh = Math.floor(m / 65536);
      const a = v * ml, b = v * mh;                       // both < 2^48: exact
      const aLo = a % 4294967296, aHi = Math.floor(a / 4294967296);
      const bLo = b % 65536, bHi = Math.floor(b / 65536);
      const low = aLo + bLo * 65536;
      const carry = Math.floor(low / 4294967296);
      v2 = (v2 + (low % 4294967296) + aHi + bHi + carry) % 4294967296;
    }
    this.i = i; this.v1 = v1; this.v2 = v2;
  }
}

/** The read offset that makes a track match the database: v1 for every shift in ±range, slid one sample at a time. */
function findOffset(raw, at, n, range, entries) {
  if (!entries || !entries.length) return null;
  const want = new Map();
  for (const e of entries) want.set(e.crc, Math.max(want.get(e.crc) || 0, e.conf));
  const S = i => i >= 0 && i < raw.length ? raw[i] : 0;
  const lo = -range;
  let c = 0, s = 0;
  for (let i = 0; i < n; i++) { const v = S(at + lo + i); c = (c + Math.imul(v, i + 1)) >>> 0; s = (s + v) >>> 0; }
  let best = null, bestConf = 0;
  for (let o = lo; o <= range; o++) {
    const conf = want.get(c);
    if (conf != null && (best == null || conf > bestConf || (conf === bestConf && Math.abs(o) < Math.abs(best)))) { best = o; bestConf = conf; }
    const first = S(at + o), next = S(at + o + n);
    c = (c - s + Math.imul(n, next)) >>> 0;
    s = (s - first + next) >>> 0;
  }
  return best;
}

// ───────────── the service ─────────────
class CdService extends EventEmitter {
  constructor(settings, resize) {
    super();
    this.s = settings;
    this.resize = resize;
    this.disc = null;
    this.seenKey = undefined;
    this.polling = false;
    this.ripAc = null;
    this.extracts = new Map();
    this.timer = setInterval(() => this.poll(), 2500);
    setTimeout(() => this.poll(), 1500);
  }
  dispose() { clearInterval(this.timer); if (this.ripAc) this.ripAc.abort(); }
  get ripping() { return !!this.ripAc; }
  changed() { this.emit('changed'); }

  /** Mounted volumes that are audio CDs (cddafs puts .TOC.plist at the top). */
  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      let found = null, toc = null;
      let names = [];
      try { names = await fsp.readdir('/Volumes'); } catch { }
      for (const n of names) {
        const v = path.join('/Volumes', n);
        if (!fs.existsSync(path.join(v, '.TOC.plist'))) continue;
        if (this.disc && this.disc.volume === v) { found = v; toc = this.disc.toc; break; }
        try { const t = readToc(v); if (!t.audio.length) continue; found = v; toc = t; break; } catch (e) { Log.info('CD TOC ' + v + ': ' + e.message); }
      }
      const key = found ? found + ':' + toc.key : null;
      if (key === this.seenKey) return;
      this.seenKey = key;
      if (!key) { this.disc = null; this.changed(); return; }
      const model = await this.driveModel(found);
      const d = this.build(found, toc, model);
      this.disc = d;
      this.changed();
      this.lookup(d);
    } catch (e) { Log.error('CD poll', e); }
    finally { this.polling = false; }
  }

  async driveModel(volume) {
    const out = await run('/usr/sbin/diskutil', ['info', volume]);
    const m = /Device \/ Media Name:\s*(.+)/.exec(out);
    return m ? m[1].replace(/\s+Media$/i, '').trim() : '';
  }

  build(volume, toc, model) {
    const mbid = toc.musicBrainzId();
    const cacheDir = path.join(AppPaths.Root, 'CD', safe(mbid));
    // the AIFF of each track: "1 Audio Track.aiff", "2 …" (names vary with the system's language)
    const files = new Map();
    try {
      for (const f of fs.readdirSync(volume)) {
        const m = /^(\d+)\D.*\.aiff?$/i.exec(f);
        if (m) files.set(parseInt(m[1], 10), { path: path.join(volume, f), info: null });
      }
    } catch { }
    const id = 'cd-' + safe(mbid);
    const album = { id, title: '音樂 CD', artist: '', year: 0, genre: '', folder: cacheDir, loose: false, artPath: null, added: 0, tracks: [] };
    const d = { volume, driveModel: model, toc, mbid, album, tracks: [], lookup: 'pending', releases: [], releaseId: null, cover: null, coverVer: 0, cacheDir, files };
    for (const t of toc.audio) {
      const sectors = toc.endOf(t) - t.lba;
      const tr = {
        id: id + '-' + t.no, path: path.join(cacheDir, String(t.no).padStart(2, '0') + '.wav'), title: `第 ${t.no} 首`, artist: '', albumArtist: '',
        album: album.title, genre: '', composer: '', year: 0, trackNo: t.no, discNo: 1, duration: sectors / 75, sampleRate: 44100, bits: 16, channels: 2,
        bitrate: 1411, codec: 'CD', size: 0, mtime: 0, hasPic: false, albumId: id,
      };
      d.tracks.push(tr); album.tracks.push(tr);
    }
    return d;
  }

  getTrack(id) { const d = this.disc; return d ? d.tracks.find(t => t.id === id) || null : null; }
  getAlbum(id) { const d = this.disc; return d && d.album.id === id ? d.album : null; }

  async eject() {
    const d = this.disc;
    if (!d) return;
    if (this.ripAc) this.ripAc.abort();
    // let the extraction let go of the files first
    for (const e of this.extracts.values()) e.stop = true;
    await sleep(200);
    let out = await run('/usr/sbin/diskutil', ['eject', d.volume]);
    if (!out) await run('/usr/bin/drutil', ['tray', 'eject']);
    this.poll();
  }

  // ───────────── names: MusicBrainz ─────────────
  async refreshInfo(discId) {
    const d = this.disc;
    if (!d) throw new Error('光碟已經退出');
    if (discId && d.album.id !== discId) throw new Error('光碟已變更，請重新開啟 CD 資訊');
    if (d.lookup === 'pending') return;
    d.lookup = 'pending'; this.changed();
    await this.lookup(d, false);
  }

  async lookup(d, chooseDefault = true) {
    try {
      await RateGate.MusicBrainz.wait(true);
      const url = `https://musicbrainz.org/ws/2/discid/${encodeURIComponent(d.mbid)}?toc=${d.toc.musicBrainzToc()}&inc=recordings+artist-credits+labels&cdstubs=no&fmt=json`;
      const res = await http(url, { timeout: 20000 });
      if (res.status === 404) { d.releases = []; d.lookup = 'none'; this.changed(); return; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const doc = await res.json();
      const rels = (doc.releases || []).map(r => parseRelease(r, d)).filter(Boolean);
      d.releases = rels;
      d.lookup = rels.length ? 'found' : 'none';
      if (chooseDefault && rels.length) apply(d, rels[0]);
      this.changed();
      if (chooseDefault && rels.length) await this.coverFor(d, rels[0].id);
    } catch (e) { Log.info('CD lookup: ' + e.message); d.lookup = 'error'; this.changed(); }
  }

  async coverFor(d, releaseId) {
    try {
      const res = await http(`https://coverartarchive.org/release/${releaseId}/front-500`, { timeout: 30000 });
      if (!res.ok) return;
      const b = Buffer.from(await res.arrayBuffer());
      if (b.length < 500 || d.releaseId !== releaseId) return;
      d.cover = b; d.coverVer++;
      this.changed();
    } catch (e) { Log.info('CD cover: ' + e.message); }
  }

  /** Apply the release selected in the CD information comparison. */
  async chooseRelease(id, discId) {
    const d = this.disc;
    if (!d) throw new Error('光碟已經退出');
    if (discId && d.album.id !== discId) throw new Error('光碟已變更，請重新開啟 CD 資訊');
    const r = d.releases.find(x => x.id === id);
    if (!r) throw new Error('找不到這個版本，請重新查找 CD 資訊');
    d.cover = null;
    apply(d, r);
    this.changed();
    await this.coverFor(d, id);
  }

  coverImage(size) {
    const c = this.disc && this.disc.cover;
    if (!c) return null;
    try { return this.resize(c, size) || c; } catch { return c; }
  }

  offsetKey(d) { return 'cdOffset:' + (d.driveModel && d.driveModel.trim() ? d.driveModel : 'mac'); }
  knownOffset(d) { const v = this.s.ui && this.s.ui[this.offsetKey(d)]; const o = parseInt(v, 10); return Number.isFinite(o) ? o : null; }

  info() {
    const d = this.disc;
    if (!d) return { disc: null, ripping: this.ripping };
    return {
      disc: {
        id: d.album.id, drive: path.basename(d.volume), driveModel: d.driveModel, mbid: d.mbid, lookup: d.lookup, release: d.releaseId,
        title: d.album.title, artist: d.album.artist, year: d.album.year, cover: !!d.cover, coverVer: d.coverVer,
        offset: this.knownOffset(d),
        releases: d.releases.map(r => ({ id: r.id, title: r.title, artist: r.artist, date: r.date, country: r.country, label: r.label,
          tracks: r.tracks.map(t => ({ no: t.no, title: t.title, artist: t.artist })) })),
        tracks: d.tracks.map(t => ({ id: t.id, no: t.trackNo, title: t.title, artist: t.artist, dur: Math.round(t.duration * 100) / 100 })),
      },
      ripping: this.ripping,
    };
  }

  // ───────────── reading the disc ─────────────
  /** The track file holding a sector, and where the sector is in it. */
  locate(d, lba) {
    for (const t of d.toc.audio) {
      const f = d.files.get(t.no);
      if (!f) continue;
      if (!f.info) { try { f.info = aiffInfo(f.path); } catch (e) { Log.info('CD AIFF ' + f.path + ': ' + e.message); f.info = { bad: true }; } }
    }
    for (const t of d.toc.audio) {
      const f = d.files.get(t.no), info = f && f.info;
      if (!info || info.bad) continue;
      if (lba >= t.lba && lba < t.lba + info.sectors) return { file: f.path, pos: info.data + (lba - t.lba) * SectorBytes, left: t.lba + info.sectors - lba };
    }
    return null;
  }

  /**
   * Reads sectors [lba, lba + count) as little-endian PCM into dst (silence where the disc has nothing: before the
   * first track, past the end). Several files are crossed when the range does.
   */
  async readSectors(d, lba, count, dst) {
    let done = 0;
    while (done < count) {
      const at = lba + done;
      const loc = this.locate(d, at);
      if (!loc) { dst.fill(0, done * SectorBytes, (done + 1) * SectorBytes); done++; continue; }
      const n = Math.min(count - done, loc.left);
      const fh = await fsp.open(loc.file, 'r');
      try {
        const len = n * SectorBytes;
        let got = 0;
        while (got < len) { const { bytesRead } = await fh.read(dst, done * SectorBytes + got, len - got, loc.pos + got); if (!bytesRead) break; got += bytesRead; }
        if (got < len) dst.fill(0, done * SectorBytes + got, done * SectorBytes + len);
      } finally { await fh.close(); }
      swap16(dst.subarray(done * SectorBytes), n * SectorBytes);
      done += n;
    }
  }

  // ───────────── playing: copy into a WAV in the cache ─────────────
  /** The track's file in the cache is complete (playable at once, also for gapless). */
  isReady(t) {
    const e = this.extracts.get(t.path);
    if (e) return e.done;
    const d = this.disc, toc = d && d.toc.audio.find(x => x.no === t.trackNo);
    return !!toc && complete(t.path, (d.toc.endOf(toc) - toc.lba) * SamplesPerSector);
  }

  /** Before a CD track plays: start copying it (and the next two) and wait until 20 s of it are there. */
  async prepare(t) {
    const d = this.disc;
    if (!d) throw new Error('光碟已經退出');
    if (!d.tracks.includes(t)) throw new Error('這張光碟不在光碟機裡');
    const e = this.start(d, t);
    for (const next of d.tracks.filter(x => x.trackNo > t.trackNo).slice(0, 2)) this.start(d, next);
    const need = Math.min(e.total, 44100 * 20);
    const until = Date.now() + 90000;
    while (!e.done && e.frames < need) {
      if (e.error) throw new Error('讀取光碟失敗：' + e.error);
      if (Date.now() > until) throw new Error('光碟讀取太慢');
      await sleep(100);
    }
  }

  start(d, t) {
    const have = this.extracts.get(t.path);
    if (have && !have.error) return have;
    const toc = d.toc.audio.find(x => x.no === t.trackNo);
    const from = toc.lba, end = d.toc.endOf(toc);
    const e = { frames: 0, total: (end - from) * SamplesPerSector, done: false, error: null, stop: false };
    this.extracts.set(t.path, e);
    if (complete(t.path, e.total)) { e.frames = e.total; e.done = true; return e; }
    // one copy at a time: the drive reads one place at a time
    this.chain = (this.chain || Promise.resolve()).then(async () => {
      let fh = null;
      try {
        await fsp.mkdir(d.cacheDir, { recursive: true });
        const bytes = e.total * 4;
        fh = await fsp.open(t.path, 'w');
        await fh.write(wavHeader(bytes), 0, 44, 0);
        await fh.truncate(44 + bytes);
        const chunk = 75 * 4;   // 4 s
        const buf = Buffer.alloc(chunk * SectorBytes);
        let pos = 44;
        for (let at = from; at < end; at += chunk) {
          if (this.disc !== d || e.stop) throw new Error('光碟已經退出');
          const n = Math.min(chunk, end - at);
          await this.readSectors(d, at, n, buf);
          await fh.write(buf, 0, n * SectorBytes, pos);
          pos += n * SectorBytes;
          e.frames += n * SamplesPerSector;
        }
        e.done = true;
      } catch (ex) {
        e.error = ex.message; Log.error('CD extract ' + t.path, ex); this.extracts.delete(t.path);
      } finally { if (fh) await fh.close().catch(() => { }); }
    });
    return e;
  }

  // ───────────── ripping ─────────────
  cancelRip() { if (this.ripAc) this.ripAc.abort(); }

  /** a: { opts, dir, tracks:[no], offset, meta }; progress events go out as 'rip'. */
  async rip(a) {
    const d = this.disc;
    if (!d) throw new Error('光碟機裡沒有音樂 CD');
    if (this.ripAc) throw new Error('正在抓取光碟');
    if (!ff.Ffmpeg.path) throw new Error('找不到 FFmpeg');
    const o = Converter.options(a.opts || {});
    const dir = typeof a.dir === 'string' ? a.dir : '';
    if (!dir || !fs.existsSync(dir)) throw new Error('請先選擇要放檔案的資料夾');
    const want = Array.isArray(a.tracks) ? new Set(a.tracks.map(Number)) : null;
    const manual = typeof a.offset === 'number' && Number.isFinite(a.offset) ? Math.round(a.offset) : null;

    let album = d.album.title, albumArtist = d.album.artist, year = d.album.year > 0 ? String(d.album.year) : '', genre = '';
    const names = new Map(d.tracks.map(t => [t.trackNo, { title: t.title, artist: t.artist }]));
    const me = a.meta;
    if (me && typeof me === 'object') {
      const str = v => typeof v === 'string' ? v : '';
      if (str(me.album)) album = me.album;
      if ('artist' in me) albumArtist = str(me.artist);
      if ('year' in me) year = str(me.year);
      genre = str(me.genre);
      if (Array.isArray(me.tracks)) for (const t of me.tracks) if (Number.isInteger(t.no)) names.set(t.no, { title: str(t.title), artist: str(t.artist) });
    }

    const audio = d.toc.audio;
    const jobs = d.tracks.filter(t => !want || want.has(t.trackNo));
    if (!jobs.length) throw new Error('沒有選擇曲目');
    const folder = path.join(dir, Converter.safeName(album && album.trim() ? album : '音樂 CD'));
    fs.mkdirSync(folder, { recursive: true });
    const ext = Converter.ext(o.format);
    const ac = this.ripAc = new AbortController();
    const signal = ac.signal;
    const check = () => { if (signal.aborted) { const e = new Error('cancelled'); e.cancelled = true; throw e; } };
    const log = [];
    const report = p => this.emit('rip', p);
    let okCount = 0, arMatched = 0, ar = null, offset = null;
    const failed = [];
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miku-rip-'));
    try {
      const now = new Date();
      log.push(`MIKU 抓取紀錄  ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`);
      log.push(`光碟機：${d.driveModel || '（不明）'} (${path.basename(d.volume)})`);
      log.push(`專輯：${albumArtist} / ${album}`);
      log.push(`MusicBrainz 光碟 ID：${d.mbid}`);
      log.push('讀取方式：macOS 系統讀取（macOS 不讓程式強制重讀磁區，正確與否以 AccurateRip 比對為準）');
      report({ state: 'start', total: jobs.length });

      ar = await AccurateRip.fetch(d.toc, signal);
      log.push(ar ? `AccurateRip：資料庫裡有這張光碟（${Math.max(...ar.tracks.map(t => t.length))} 種版本）` : 'AccurateRip：這張光碟不在資料庫裡');
      report({ state: 'ar', found: !!ar });

      const Margin = 10;
      const raws = new Map();
      offset = manual != null ? manual : this.knownOffset(d);
      let found = false;
      if (offset == null && ar && audio.length >= 3) {
        const probe = audio[Math.floor(audio.length / 2)];
        const job = jobs.find(t => t.trackNo === probe.no) || d.tracks.find(t => t.trackNo === probe.no);
        report({ state: 'offset' });
        const raw = await this.readRaw(d, probe, Margin, path.join(tmpDir, probe.no + '.raw'), job.id, report, signal);
        raws.set(probe.no, raw);
        const n = (d.toc.endOf(probe) - probe.lba) * SamplesPerSector;
        const bytes = await fsp.readFile(raw.file);
        const samples = new Uint32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 4));
        const at = (probe.lba - raw.from) * SamplesPerSector;
        offset = findOffset(samples, at, n, Margin * SamplesPerSector - 100, ar.tracks[audio.indexOf(probe)]);
        if (offset != null) {
          this.s.ui = this.s.ui || {};
          this.s.ui[this.offsetKey(d)] = String(offset);
          found = true;
          log.push(`讀取偏移：${offset > 0 ? '+' : ''}${offset}（用 AccurateRip 找到，已記住這台光碟機）`);
        }
      }
      if (offset == null) log.push('讀取偏移：未知，用 0（AccurateRip 比對可能不符）');
      else if (!found) log.push(`讀取偏移：${offset > 0 ? '+' : ''}${offset}`);
      const off = offset || 0;
      report({ state: 'offsetDone', offset });
      log.push('');

      for (const t of jobs) {
        check();
        const toc = audio.find(x => x.no === t.trackNo);
        const idx = audio.indexOf(toc);
        const nm = names.get(t.trackNo) || { title: t.title, artist: t.artist };
        const rawFile = path.join(tmpDir, t.trackNo + '.raw'), wav = path.join(tmpDir, t.trackNo + '.wav');
        try {
          const raw = raws.get(t.trackNo) || await this.readRaw(d, toc, Margin, rawFile, t.id, report, signal);
          const n = (d.toc.endOf(toc) - toc.lba) * SamplesPerSector;
          const start = (toc.lba - raw.from) * SamplesPerSector + off;
          const sum = new Summer(n, idx === 0, idx === audio.length - 1);
          const src = await fsp.open(raw.file, 'r'), dst = await fsp.open(wav, 'w');
          try {
            await dst.write(wavHeader(n * 4), 0, 44, 0);
            const rawSamples = Math.floor((await src.stat()).size / 4);
            const buf = Buffer.alloc(1 << 20);
            let wpos = 44;
            for (let done = 0; done < n;) {
              const cnt = Math.min(buf.length / 4, n - done);
              const from = start + done;
              buf.fill(0, 0, cnt * 4);
              const a0 = Math.max(from, 0), a1 = Math.min(from + cnt, rawSamples);
              if (a1 > a0) {
                let got = 0;
                const need = (a1 - a0) * 4, at = (a0 - from) * 4;
                while (got < need) { const { bytesRead } = await src.read(buf, at + got, need - got, a0 * 4 + got); if (!bytesRead) break; got += bytesRead; }
              }
              sum.add(buf, cnt * 4);
              await dst.write(buf, 0, cnt * 4, wpos);
              wpos += cnt * 4; done += cnt;
            }
          } finally { await src.close(); await dst.close(); }

          let arState, arText, conf = 0;
          if (!ar) { arState = 'none'; arText = '不在資料庫'; }
          else {
            const entries = ar.tracks[idx] || [];
            const hits = entries.filter(e => e.crc === sum.v1 || e.crc === sum.v2);
            if (hits.length) { arState = 'match'; conf = Math.max(...hits.map(e => e.conf)); arText = `相符（信心 ${conf}）`; arMatched++; }
            else if (!entries.length) { arState = 'none'; arText = '這首不在資料庫'; }
            else { arState = 'mismatch'; arText = '不符'; }
          }
          report({ state: 'encode', id: t.id, pct: 0 });
          const title = nm.title && nm.title.trim() ? nm.title : `Track ${t.trackNo}`;
          const meta = {
            title, artist: nm.artist && nm.artist.trim() ? nm.artist : albumArtist, album, album_artist: albumArtist, date: year, genre,
            track: `${t.trackNo}/${audio[audio.length - 1].no}`, disc: '1',
          };
          const srcTrack = { path: wav, codec: 'WAV', bits: 16, sampleRate: 44100, channels: 2, duration: n / 44100, title };
          const stem = Converter.safeName(`${String(t.trackNo).padStart(2, '0')}. ${title}`);
          let target = path.join(folder, stem + ext);
          for (let k = 2; fs.existsSync(target); k++) target = path.join(folder, `${stem} (${k})${ext}`);
          let last = -1;
          await Converter.convert(srcTrack, target, o, 0, o.cover ? d.cover : null, x => {
            const p = Math.round(x * 100) / 100;
            if (p !== last) { last = p; report({ state: 'encode', id: t.id, pct: p }); }
          }, signal, { meta });
          okCount++;
          const h8 = v => (v >>> 0).toString(16).toUpperCase().padStart(8, '0');
          log.push(`第 ${String(t.trackNo).padStart(2, '0')} 首  ${title}`);
          log.push(`    AccurateRip v1 ${h8(sum.v1)}  v2 ${h8(sum.v2)}  ${arText}`);
          log.push(`    → ${path.basename(target)}`);
          report({ state: 'done', id: t.id, ar: arState, conf, errors: 0, rereads: 0 });
        } catch (e) {
          if (e.cancelled || signal.aborted) throw Object.assign(new Error('cancelled'), { cancelled: true });
          Log.error('CD rip track ' + t.trackNo, e);
          failed.push({ no: t.trackNo, error: e.message });
          log.push(`第 ${String(t.trackNo).padStart(2, '0')} 首  失敗：${e.message}`);
          report({ state: 'fail', id: t.id, error: e.message });
        } finally {
          for (const f of [rawFile, wav]) { try { fs.unlinkSync(f); } catch { } }
        }
      }
      log.push('');
      log.push(`完成 ${okCount} / ${jobs.length} 首，AccurateRip 相符 ${arMatched} 首`);
      try { fs.writeFileSync(path.join(folder, Converter.safeName(album || '音樂 CD') + '.log'), '﻿' + log.join('\n') + '\n'); } catch { }
      return { done: okCount, total: jobs.length, arMatched, ar: !!ar, offset, failed, cancelled: false, dir: folder };
    } catch (e) {
      if (e.cancelled || signal.aborted) return { done: okCount, total: jobs.length, arMatched, ar: false, offset: null, failed, cancelled: true, dir: folder };
      throw e;
    } finally {
      this.ripAc = null;
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { }
    }
  }

  /** A track plus `margin` sectors each side, as little-endian PCM, into a raw file. */
  async readRaw(d, toc, margin, file, id, report, signal) {
    const from = toc.lba - margin, to = d.toc.endOf(toc) + margin, count = to - from;
    const block = 75 * 4;
    const buf = Buffer.alloc(block * SectorBytes);
    const fh = await fsp.open(file, 'w');
    let lastPct = -1;
    try {
      for (let i = 0; i < count; i += block) {
        if (signal.aborted) throw Object.assign(new Error('cancelled'), { cancelled: true });
        if (this.disc !== d) throw new Error('光碟已經退出');
        const n = Math.min(block, count - i);
        await this.readSectors(d, from + i, n, buf);
        await fh.write(buf, 0, n * SectorBytes, i * SectorBytes);
        const p = Math.round((i + n) / count * 1000) / 1000;
        if (p - lastPct >= 0.005 || p >= 1) { lastPct = p; report({ state: 'read', id, pct: p }); }
      }
    } finally { await fh.close(); }
    return { file, from, count };
  }
}

function complete(file, frames) { try { return fs.statSync(file).size === 44 + frames * 4; } catch { return false; } }

function credit(e) {
  const ac = e && e['artist-credit'];
  if (!Array.isArray(ac)) return '';
  return ac.map(c => (c.name || '') + (c.joinphrase || '')).join('').trim();
}

function parseRelease(rel, d) {
  const media = rel.media || [];
  let medium = media.find(m => (m.discs || []).some(x => x.id === d.mbid));
  if (!medium) medium = media.find(m => (m.tracks || []).length === d.tracks.length);
  if (!medium) return null;
  const li = (rel['label-info'] || []).find(l => l && l.label && typeof l.label === 'object');
  const r = { id: rel.id || '', title: rel.title || '', artist: credit(rel), date: rel.date || '', country: rel.country || '', label: li ? li.label.name || '' : '', tracks: [] };
  (medium.tracks || []).forEach((t, i) => {
    let artist = credit(t);
    if (!artist && t.recording) artist = credit(t.recording);
    r.tracks.push({ no: i + 1, title: t.title || '', artist: artist || r.artist });
  });
  return r;
}

function apply(d, r) {
  d.releaseId = r.id;
  d.album.title = r.title && r.title.trim() ? r.title : '音樂 CD';
  d.album.artist = r.artist;
  const y = parseInt((r.date || '').slice(0, 4), 10);
  d.album.year = Number.isFinite(y) ? y : 0;
  d.tracks.forEach((t, i) => {
    t.album = d.album.title; t.albumArtist = r.artist; t.year = d.album.year;
    const x = r.tracks.find(z => z.no === i + 1);
    if (x) { t.title = x.title; t.artist = x.artist; }
  });
}

module.exports = { CdService, readToc, parsePlist, Toc, Summer, findOffset };

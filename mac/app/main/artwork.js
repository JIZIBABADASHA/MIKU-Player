'use strict';
// Album / track / artist pictures: local, embedded, online (Apple Music, Deezer, MusicBrainz). Port of Artwork.cs
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { nativeImage } = require('electron');
const { AppPaths, Log, hash, norm, similarity, getJson, getBytes, http, firstArtist, RateGate } = require('./common');
const ff = require('./ffmpeg');

const MissExt = '.miss3';
const Sizes = [64, 128, 256, 384, 512, 768, 1024, 1600, 2400];

class Semaphore {
  constructor(n) { this.n = n; this.q = []; }
  async acquire() { if (this.n > 0) { this.n--; return; } await new Promise(r => this.q.push(r)); }
  release() { const r = this.q.shift(); if (r) r(); else this.n++; }
}

function resize(src, size) {
  try {
    const img = nativeImage.createFromBuffer(src);
    if (img.isEmpty()) return src.length > 100 ? src : null; // e.g. WebP: the browser can show the original
    const { width: w, height: h } = img.getSize();
    if (!w || !h) return null;
    const scale = Math.min(1, size / Math.max(w, h));
    const out = scale < 1 ? img.resize({ width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), quality: 'best' }) : img;
    return out.toJPEG(size >= 1024 ? 94 : 90);
  } catch (e) {
    Log.info('Resize failed (' + e.message + '), serving original image');
    return src.length > 100 ? src : null;
  }
}
function validImage(buf) {
  try { const img = nativeImage.createFromBuffer(buf); return !img.isEmpty() || /^RIFF....WEBP/s.test(buf.slice(0, 12).toString('latin1')); } catch { return false; }
}

const exists = f => { try { fs.accessSync(f); return true; } catch { return false; } };
const recentlyMissed = f => { try { return Date.now() - fs.statSync(f).mtimeMs < 5 * 864e5; } catch { return false; } };
const cleanArtist = s => firstArtist(s).replace(/^[【\[(]+|[】\])]+$/g, '').trim();
const Bracketed = /\s*[(（\[【][^)）\]】]*[)）\]】]/g;
const Joiners = /\s*(?:,|、|&|＆|×|\/|／|\bfeat\.?(?=\s)|\bft\.|\bwith\b)\s*/i;
/** The artist to put in a search: the first name only, without "(CV. …)" (ArtworkService.SearchArtist). */
function searchArtist(s) {
  let first = firstArtist(s);
  const bare = first.replace(Bracketed, '').trim();
  if (bare) first = bare;
  const part = first.split(Joiners).map(p => p.trim()).find(p => p) || first;
  return part.replace(/^[【\[(]+|[】\])]+$/g, '').trim();
}
/** Version of the album picture rules (core.js ART_RULES). 2: the embedded picture wins over a folder picture. */
const Rules = 2;
const artistId = name => hash('artist|' + norm(name));

/** Pixel size from the first bytes of a JPEG / PNG / WebP, or null. */
function parseDimensions(b, n = b.length) {
  if (n >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (n >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const k = b.toString('latin1', 12, 16);
    if (k === 'VP8 ') return [(b[26] | (b[27] << 8)) & 0x3FFF, (b[28] | (b[29] << 8)) & 0x3FFF];
    if (k === 'VP8L') { const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return [(v & 0x3FFF) + 1, ((v >> 14) & 0x3FFF) + 1]; }
    if (k === 'VP8X') return [1 + (b[24] | (b[25] << 8) | (b[26] << 16)), 1 + (b[27] | (b[28] << 8) | (b[29] << 16))];
    return null;
  }
  if (n >= 4 && b[0] === 0xFF && b[1] === 0xD8) {
    let i = 2;
    while (i + 9 < n) {
      if (b[i] !== 0xFF) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xFF) { i++; continue; }
      if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
      const len = (b[i + 2] << 8) | b[i + 3];
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return [(b[i + 7] << 8) | b[i + 8], (b[i + 5] << 8) | b[i + 6]];
      if (len < 2) return null;
      i += 2 + len;
    }
  }
  return null;
}

class ArtworkService extends EventEmitter {
  constructor(lib, settings) {
    super();
    this.lib = lib; this.s = settings;
    this.resizeGate = new Semaphore(Math.max(2, require('os').cpus().length - 1));
    this.onlineGate = new Semaphore(2);
    this.inflight = new Map();
    this.onlineInflight = new Map();
    this.dims = new Map();
    lib.on('tracksRead', tracks => this.reread(tracks));
    ArtworkService.dropOldThumbs();
  }

  /** Thumbnails made under older picture rules are deleted once (Art/Thumbs/.rules). */
  static dropOldThumbs() {
    const mark = path.join(AppPaths.Thumbs, '.rules');
    try {
      if (exists(mark) && fs.readFileSync(mark, 'utf8').trim() === String(Rules)) return;
      for (const f of fs.readdirSync(AppPaths.Thumbs)) if (f.endsWith('.jpg')) try { fs.unlinkSync(path.join(AppPaths.Thumbs, f)); } catch { }
      fs.writeFileSync(mark, String(Rules));
    } catch (e) { Log.error('Thumbs', e); }
  }

  /** Tags read again: drop thumbnails made from the old pictures and tell the UI. */
  reread(tracks) {
    for (const id of new Set(tracks.map(t => t.albumId).filter(Boolean))) { this.forgetThumbs('a_' + id); this.emit('updated', 'album', id); }
    for (const t of tracks.filter(t => { const a = this.lib.getAlbum(t.albumId); return !a || a.loose; }).slice(0, 500)) { this.forgetThumbs('t_' + t.id); this.emit('updated', 'track', t.id); }
  }
  overridePath(id) { return path.join(AppPaths.Override, 'a_' + id + '.jpg'); }
  online(name) { return path.join(AppPaths.OnlineArt, name + '.jpg'); }

  albumAsync(albumId, size) { return this.cached('a_' + albumId, size, () => this.albumSource(albumId)); }
  trackAsync(trackId, size) {
    const t = this.lib.getTrack(trackId);
    if (!t) return Promise.resolve(null);
    const a = this.lib.getAlbum(t.albumId);
    if (a && (!a.loose || exists(this.overridePath(a.id)))) return this.albumAsync(a.id, size);
    return this.cached('t_' + trackId, size, () => this.trackSource(t));
  }

  async albumSource(albumId) {
    const a = this.lib.getAlbum(albumId);
    if (!a) return null;
    const ov = this.overridePath(albumId);
    if (exists(ov)) try { return fs.readFileSync(ov); } catch { }
    // the picture in the files first: it is what the tag editor updates, while an old cover.jpg often stays behind
    for (const t of a.tracks.filter(t => t.hasPic).slice(0, 3)) { const b = await ff.picture(t.path); if (b && b.length > 100) return b; }
    if (a.artPath) try { return fs.readFileSync(a.artPath); } catch { }
    const on = this.online('a_' + albumId);
    if (exists(on)) return fs.readFileSync(on);
    if (this.s.onlineArt) (a.loose && a.tracks.length ? this.fetchTrackOnline(a.tracks[0]) : this.fetchAlbumOnline(a)).catch(() => { });
    if (a.loose && a.tracks.length) { const t0 = this.online('t_' + a.tracks[0].id); if (exists(t0)) return fs.readFileSync(t0); }
    return null;
  }
  async trackSource(t) {
    const ov = this.overridePath(t.albumId);
    if (exists(ov)) try { return fs.readFileSync(ov); } catch { }
    if (t.hasPic) { const b = await ff.picture(t.path); if (b) return b; }
    const a = this.lib.getAlbum(t.albumId);
    if (a && a.artPath) try { return fs.readFileSync(a.artPath); } catch { }
    const on = this.online('t_' + t.id);
    if (exists(on)) return fs.readFileSync(on);
    if (this.s.onlineArt) this.fetchTrackOnline(t).catch(() => { });
    return null;
  }

  async cached(key, size, source) {
    size = Math.min(2400, Math.max(32, size <= 0 ? 600 : size));
    size = Sizes.find(s => s >= size);
    const thumb = path.join(AppPaths.Thumbs, `${key}_${size}.jpg`);
    try { return await fs.promises.readFile(thumb); } catch { }
    if (!this.inflight.has(thumb)) {
      const p = (async () => {
        const src = await source();
        if (!src) return null;
        await this.resizeGate.acquire();
        try {
          const bytes = resize(src, size);
          if (bytes) try { await fs.promises.writeFile(thumb, bytes); } catch { }
          return bytes;
        } finally { this.resizeGate.release(); }
      })();
      this.inflight.set(thumb, p);
      p.finally(() => this.inflight.delete(thumb)).catch(() => { });
    }
    return this.inflight.get(thumb);
  }

  forgetThumbs(key) {
    try { for (const f of fs.readdirSync(AppPaths.Thumbs)) if (f.startsWith(key + '_')) fs.unlinkSync(path.join(AppPaths.Thumbs, f)); } catch { }
  }

  // ───────────── online lookup ─────────────
  async findAlbumUrl(a) {
    const artist = cleanArtist(a.artist);
    const folder = path.basename(a.folder || '');
    const titles = [];
    if (!a.loose && a.title && a.title.trim()) titles.push(a.title);
    if (folder.trim() && norm(folder) !== norm(a.title)) titles.push(folder);
    for (const title of titles) {
      let c = await this.albumCandidates(artist, title, 12);
      let url = bestAlbum(c, artist, title, false);
      if (url) return url;
      if (artist) { c = await this.albumCandidates('', title, 12); url = bestAlbum(c, artist, title, true); if (url) return url; }
    }
    for (const t of a.tracks.slice(0, 8)) { const url = await this.findSongUrl(t); if (url) return url; }
    return null;
  }
  async findSongUrl(t) {
    const c = await this.songCandidates(cleanArtist(t.artist), t.title, 15);
    let best = 0, url = null;
    for (const x of c) {
      const ts = similarity(t.title, x.title);
      if (ts < 0.8) continue;
      const ars = !t.artist ? 0.5 : Math.max(similarity(t.artist, x.artist), similarity(t.artist, x.artist, false));
      const durOk = t.duration > 0 && x.duration > 0 && Math.abs(t.duration - x.duration) <= 3;
      if (ars < 0.5 && !durOk) continue;
      const score = ts * 0.5 + ars * 0.3 + (durOk ? 0.2 : 0);
      if (score > best) { best = score; url = x.url; }
    }
    return url;
  }

  onlineJob(target, fn) {
    if (recentlyMissed(target + MissExt)) return Promise.resolve(false);
    if (this.onlineInflight.has(target)) return this.onlineInflight.get(target);
    const p = (async () => {
      await this.onlineGate.acquire();
      try {
        const ok = await fn();
        if (!ok) try { fs.writeFileSync(target + MissExt, new Date().toISOString()); } catch { }
        return ok;
      } catch (e) { Log.info('Online art failed: ' + e.message); return false; }
      finally { this.onlineGate.release(); this.onlineInflight.delete(target); }
    })();
    this.onlineInflight.set(target, p);
    return p;
  }

  fetchAlbumOnline(a) {
    const target = this.online('a_' + a.id);
    return this.onlineJob(target, async () => {
      const url = await this.findAlbumUrl(a);
      const ok = !!url && await download(url, target);
      if (ok) { this.forgetThumbs('a_' + a.id); this.emit('updated', 'album', a.id); }
      return ok;
    });
  }
  fetchTrackOnline(t) {
    const target = this.online('t_' + t.id);
    return this.onlineJob(target, async () => {
      let url = await this.findSongUrl(t);
      if (!url) {
        const a = this.lib.getAlbum(t.albumId);
        const folder = a ? path.basename(a.folder || '') : null;
        if (folder && folder.trim()) url = bestAlbum(await this.albumCandidates(cleanArtist(t.artist), folder, 12), cleanArtist(t.artist), folder, false);
      }
      const ok = !!url && await download(url, target);
      if (ok) {
        this.forgetThumbs('t_' + t.id); this.emit('updated', 'track', t.id);
        const a = this.lib.getAlbum(t.albumId);
        if (a) { this.forgetThumbs('a_' + a.id); this.emit('updated', 'album', a.id); }
      }
      return ok;
    });
  }

  async fetchAllMissing(progress, signal, retryMisses = true) {
    const missing = this.lib.albumList().filter(a => !a.artPath && !a.tracks.some(t => t.hasPic) && !exists(this.overridePath(a.id))
      && !exists(this.online('a_' + a.id)) && !(a.loose && a.tracks.length && exists(this.online('t_' + a.tracks[0].id))));
    let done = 0, found = 0;
    for (const a of missing) {
      if (signal && signal.aborted) return;
      if (retryMisses) {
        try { fs.unlinkSync(this.online('a_' + a.id) + MissExt); } catch { }
        if (a.tracks.length) try { fs.unlinkSync(this.online('t_' + a.tracks[0].id) + MissExt); } catch { }
      }
      const ok = a.loose ? await this.fetchTrackOnline(a.tracks[0]) : await this.fetchAlbumOnline(a);
      if (ok) found++;
      progress && progress({ done: ++done, total: missing.length, found });
    }
  }
  retryAlbum(id) {
    const a = this.lib.getAlbum(id);
    if (!a) return;
    try { fs.unlinkSync(this.online('a_' + a.id) + MissExt); } catch { }
    this.fetchAlbumOnline(a).catch(() => { });
  }

  // ───────────── manual choice ─────────────
  sourceOf(id) {
    const a = this.lib.getAlbum(id);
    if (!a) return 'none';
    if (exists(this.overridePath(id))) return 'override';
    if (a.tracks.some(t => t.hasPic)) return 'embedded';
    if (a.artPath) return 'folder';
    if (exists(this.online('a_' + id))) return 'online';
    if (a.loose && a.tracks.length && exists(this.online('t_' + a.tracks[0].id))) return 'online';
    return 'none';
  }
  /** Candidates for the picker; part: 'albums' | 'songs' | null (both). Every service is asked at the same time. */
  async candidates(albumId, query, part = null) {
    const a = this.lib.getAlbum(albumId);
    const albums = part !== 'songs', songs = part !== 'albums';
    const tasks = [];
    if (query && query.trim()) {
      if (albums) tasks.push(this.albumCandidates('', query, 25, true));
      if (songs) tasks.push(this.songCandidates('', query, 15, true));
    } else if (a) {
      const artist = searchArtist(a.artist);
      const title = a.loose ? path.basename(a.folder || '') : a.title;
      if (albums) { tasks.push(this.albumCandidates(artist, title, 20, true)); if (artist) tasks.push(this.albumCandidates('', title, 20, true)); }
      if (songs) for (const t of a.tracks.slice(0, 3)) tasks.push(this.songCandidates(searchArtist(t.artist), t.title, 8, true));
    }
    const lists = await Promise.all(tasks.map(p => p.catch(() => [])));
    return dedupe(lists.flat()).slice(0, 60);
  }

  /** Real pixel sizes of candidate pictures ("1400×1400"), read from the first bytes of each. */
  async dimensions(urls) {
    const list = [...new Set((urls || []).filter(u => typeof u === 'string' && /^https?:\/\//.test(u)))].slice(0, 80);
    const out = {};
    let i = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (i < list.length) {
        const u = list[i++];
        if (this.dims.has(u)) { out[u] = this.dims.get(u); continue; }
        const d = await readDimensions(u);
        if (d) this.dims.set(u, d);
        out[u] = d || '';
      }
    }));
    return out;
  }
  /** The bytes of the picture an album shows now, or null. */
  currentPicture(albumId) { return this.albumSource(albumId); }
  async sourceDims(albumId) {
    try { const b = await this.albumSource(albumId); const wh = b && parseDimensions(b); return wh ? `${wh[0]}×${wh[1]}` : null; } catch { return null; }
  }
  /** A new cover was written into the files: drop MIKU's own pictures for the album, which would hide it. */
  dropStoredArt(albumId) {
    const a = this.lib.getAlbum(albumId);
    try { fs.unlinkSync(this.overridePath(albumId)); } catch { }
    try { fs.unlinkSync(this.online('a_' + albumId)); } catch { }
    if (a && a.tracks.length) try { fs.unlinkSync(this.online('t_' + a.tracks[0].id)); } catch { }
    this.forgetThumbs('a_' + albumId);
    this.emit('updated', 'album', albumId);
  }
  /** The album's id changed (its title was edited): the picture chosen for it goes along. */
  moveStoredArt(oldId, newId) {
    if (!oldId || !newId || oldId === newId) return;
    for (const [from, to] of [[this.overridePath(oldId), this.overridePath(newId)], [this.online('a_' + oldId), this.online('a_' + newId)]])
      try { if (exists(from) && !exists(to)) fs.renameSync(from, to); } catch { }
    this.forgetThumbs('a_' + newId);
    this.emit('updated', 'album', newId);
  }
  async setOverrideFromUrl(id, url) { return this.setOverride(id, await getBytes(url)); }
  setOverride(albumId, bytes) {
    const data = userPicture(bytes);
    fs.mkdirSync(AppPaths.Override, { recursive: true });
    fs.writeFileSync(this.overridePath(albumId), data);
    this.forgetThumbs('a_' + albumId);
    const a = this.lib.getAlbum(albumId);
    if (a) for (const t of a.tracks) this.forgetThumbs('t_' + t.id);
    this.emit('updated', 'album', albumId);
    if (a) for (const t of a.tracks.slice(0, 200)) this.emit('updated', 'track', t.id);
    return true;
  }
  clearOverride(id) { try { fs.unlinkSync(this.overridePath(id)); } catch { } this.forgetThumbs('a_' + id); this.emit('updated', 'album', id); }
  rejectOnline(id) {
    const a = this.lib.getAlbum(id);
    try { fs.unlinkSync(this.online('a_' + id)); } catch { }
    if (a && a.tracks.length) try { fs.unlinkSync(this.online('t_' + a.tracks[0].id)); } catch { }
    this.forgetThumbs('a_' + id);
    this.emit('updated', 'album', id);
  }

  // ───────────── providers ─────────────
  async albumCandidates(artist, title, limit, user = false) {
    const lists = await Promise.all([deezerAlbums(artist, title, limit), this.itunes(artist, title, 'album', 'tw', limit, user), this.itunes(artist, title, 'album', 'jp', limit, user)]);
    const all = lists.flat();
    if (all.length < 3) all.push(...await this.musicBrainz(artist, title, user));
    return all;
  }
  async songCandidates(artist, title, limit, user = false) {
    // a search the user waits for asks only Apple's jp store (same covers as tw; Apple allows few requests)
    const tasks = [deezerSongs(artist, title, limit), this.itunes(artist, title, 'song', 'jp', limit, user)];
    if (!user) tasks.push(this.itunes(artist, title, 'song', 'tw', limit, user));
    return (await Promise.all(tasks)).flat();
  }
  async itunes(artist, title, entity, country, limit, user = false) {
    const list = [];
    try {
      await RateGate.Apple.wait(user);
      const term = encodeURIComponent(((artist || '') + ' ' + (title || '')).trim());
      const j = await getJson(`https://itunes.apple.com/search?term=${term}&entity=${entity}&limit=${limit}&country=${country}`);
      for (const e of (j && j.results) || []) {
        const art = e.artworkUrl100;
        if (!art) continue;
        list.push({ url: art.replace('100x100bb', '1600x1600bb'), thumb: art.replace('100x100bb', '300x300bb'), title: entity === 'song' ? e.trackName : e.collectionName,
          artist: e.artistName, source: 'Apple Music' + (country === 'jp' ? ' JP' : ''), size: '1600px', duration: e.trackTimeMillis ? e.trackTimeMillis / 1000 : 0 });
      }
    } catch { }
    return list;
  }
  async musicBrainz(artist, title, user = false) {
    const list = [];
    try {
      await RateGate.MusicBrainz.wait(user);
      const q = `releasegroup:"${title.replace(/"/g, '')}"` + (artist ? ` AND artist:"${artist.replace(/"/g, '')}"` : '');
      const j = await getJson('https://musicbrainz.org/ws/2/release-group/?fmt=json&limit=8&query=' + encodeURIComponent(q));
      for (const e of (j && j['release-groups']) || []) {
        const name = e['artist-credit'] && e['artist-credit'][0] ? e['artist-credit'][0].name : null;
        list.push({ url: `https://coverartarchive.org/release-group/${e.id}/front-1200`, thumb: `https://coverartarchive.org/release-group/${e.id}/front-250`, title: e.title, artist: name, source: 'MusicBrainz', size: '1200px' });
      }
    } catch { }
    return list;
  }

  // ───────────── artist pictures ─────────────
  artistOverridePath(id) { return path.join(AppPaths.Override, 'r_' + id + '.jpg'); }
  artistAsync(name, size) {
    const id = artistId(name);
    return this.cached('r_' + id, size, () => {
      const ov = this.artistOverridePath(id);
      if (exists(ov)) try { return fs.readFileSync(ov); } catch { }
      const file = this.online('r_' + id);
      if (exists(file)) return fs.readFileSync(file);
      if (this.s.artistImages && this.s.onlineArt) this.fetchArtist(name, id, file).catch(() => { });
      return null;
    });
  }
  artistSourceOf(name) {
    const id = artistId(name);
    if (exists(this.artistOverridePath(id))) return 'override';
    if (exists(this.online('r_' + id))) return 'online';
    return 'none';
  }
  /** Deezer artist photos, then album covers found by the name. */
  async artistCandidates(name, query) {
    const q = query && query.trim() ? query.trim() : cleanArtist(name);
    const list = [];
    if (!q) return list;
    const j = await getJson('https://api.deezer.com/search/artist?limit=25&q=' + encodeURIComponent(q));
    for (const e of (j && j.data) || []) {
      const pic = e.picture_xl;
      if (!pic || pic.includes('/artist//')) continue;
      list.push({ url: pic, thumb: e.picture_medium || pic, title: e.name, artist: e.nb_fan > 0 ? `${e.nb_fan.toLocaleString('en-US')} 位粉絲` : '', source: 'Deezer', size: '1000×1000' });
    }
    list.push(...await this.albumCandidates('', q, 20, true));
    return dedupe(list).slice(0, 60);
  }
  async setArtistOverrideFromUrl(name, url) { return this.setArtistOverride(name, await getBytes(url)); }
  setArtistOverride(name, bytes) {
    const data = userPicture(bytes);
    const id = artistId(name);
    fs.mkdirSync(AppPaths.Override, { recursive: true });
    fs.writeFileSync(this.artistOverridePath(id), data);
    this.forgetThumbs('r_' + id);
    this.emit('updated', 'artist', name);
    return true;
  }
  clearArtistOverride(name) {
    const id = artistId(name);
    try { fs.unlinkSync(this.artistOverridePath(id)); } catch { }
    try { fs.unlinkSync(this.online('r_' + id) + MissExt); } catch { }
    this.forgetThumbs('r_' + id);
    this.emit('updated', 'artist', name);
  }
  fetchArtist(name, id, target) {
    if (!name || !name.trim() || name === 'Various Artists' || name === '未知演出者') return Promise.resolve(false);
    return this.onlineJob(target, async () => {
      let url = null, best = 0;
      const j = await getJson('https://api.deezer.com/search/artist?limit=8&q=' + encodeURIComponent(name));
      for (const e of (j && j.data) || []) {
        const pic = e.picture_xl;
        if (!pic || pic.includes('/artist//')) continue;
        const s = Math.max(similarity(name, e.name), similarity(name, e.name, false));
        if (s >= 0.85 && s > best) { best = s; url = pic; }
      }
      const ok = !!url && await download(url, target);
      if (ok) { this.forgetThumbs('r_' + id); this.emit('updated', 'artist', name); }
      return ok;
    });
  }
}

function dedupe(list) {
  const seen = new Set(), out = [];
  for (const c of list) { if (!c || !c.url || seen.has(c.url)) continue; seen.add(c.url); const { duration, ...rest } = c; out.push(rest); }
  return out;
}
/** A picture the user picked: anything Chromium reads → high quality JPEG (at most 3000 px); WebP etc. as-is. */
function userPicture(bytes) {
  if (!bytes || bytes.length < 500) throw new Error('圖片太小或無效');
  let data = bytes;
  const img = nativeImage.createFromBuffer(bytes);
  if (!img.isEmpty()) {
    const { width, height } = img.getSize();
    if (width < 50) throw new Error('圖片太小');
    data = resize(bytes, Math.min(3000, Math.max(width, height))) || bytes;
  }
  return data;
}
async function readDimensions(url) {
  try {
    const res = await http(url, { timeout: 10000, headers: { Range: 'bytes=0-262143', Accept: 'image/*' } });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    let buf = Buffer.alloc(0);
    try {
      while (buf.length < 262144) {
        const { done, value } = await reader.read();
        if (done) break;
        buf = Buffer.concat([buf, Buffer.from(value)]);
        const wh = parseDimensions(buf);
        if (wh) return `${wh[0]}×${wh[1]}`;
      }
    } finally { try { reader.cancel(); } catch { } }
    const wh = parseDimensions(buf);
    return wh ? `${wh[0]}×${wh[1]}` : null;
  } catch { return null; }
}

function bestAlbum(c, artist, title, strict) {
  let best = 0, url = null;
  for (const x of c) {
    const ts = similarity(title, x.title);
    const ars = !artist ? 0.6 : Math.max(similarity(artist, x.artist), similarity(artist, x.artist, false));
    const ok = strict ? ts >= 0.95 : ts >= 0.72 && (ars >= 0.5 || ts >= 0.95);
    if (!ok) continue;
    const score = ts * 0.62 + ars * 0.38;
    if (score > best) { best = score; url = x.url; }
  }
  return best >= 0.6 ? url : null;
}
async function deezerAlbums(artist, title, limit) {
  const q = !artist ? title : `artist:"${artist}" album:"${title}"`;
  const j = await getJson(`https://api.deezer.com/search/album?limit=${limit}&q=` + encodeURIComponent(q));
  const list = [];
  for (const e of (j && j.data) || []) {
    const xl = e.cover_xl;
    if (!xl || xl.includes('/cover//')) continue;
    list.push({ url: xl, thumb: e.cover_medium || xl, title: e.title, artist: e.artist && e.artist.name, source: 'Deezer', size: '1000px' });
  }
  return list;
}
async function deezerSongs(artist, title, limit) {
  const q = !artist ? title : `artist:"${artist}" track:"${title}"`;
  const j = await getJson(`https://api.deezer.com/search?limit=${limit}&q=` + encodeURIComponent(q));
  const list = [];
  for (const e of (j && j.data) || []) {
    const al = e.album; if (!al) continue;
    const xl = al.cover_xl;
    if (!xl || xl.includes('/cover//')) continue;
    list.push({ url: xl, thumb: al.cover_medium || xl, title: e.title, artist: e.artist && e.artist.name, source: 'Deezer · ' + al.title, size: '1000px', duration: e.duration || 0 });
  }
  return list;
}
async function download(url, target) {
  try {
    const bytes = await getBytes(url);
    if (bytes.length < 2000 || !validImage(bytes)) return false;
    await fs.promises.writeFile(target, bytes);
    return true;
  } catch { return false; }
}

module.exports = { ArtworkService, searchArtist, parseDimensions, resize };

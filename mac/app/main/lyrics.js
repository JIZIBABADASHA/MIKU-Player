'use strict';
// Lyrics: sidecar LRC, embedded, cached online results, LRCLIB and NetEase (port of Lyrics.cs)
const fs = require('fs');
const path = require('path');
const { AppPaths, Log, decodeUnknown, similarity, http, firstArtist, sleep } = require('./common');
const ff = require('./ffmpeg');

const TimeTag = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/y;
const TimeTagG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const WordTagG = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
const Meta = /^\[(ar|ti|al|by|re|ve|length|au|offset|#)\s*:(.*)\]\s*$/i;

const secs = m => (+m[1]) * 60 + (+m[2]) + (m[3] ? (+m[3]) / Math.pow(10, m[3].length) : 0);
const looksSynced = text => !!text && (text.match(TimeTagG) || []).length >= 3;

function parse(text) {
  const lines = [];
  let offset = 0;
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const meta = Meta.exec(line);
    if (meta) { if (meta[1].toLowerCase() === 'offset') { const v = parseFloat(meta[2]); if (!isNaN(v)) offset = v / 1000; } continue; }
    const times = [];
    let pos = 0;
    for (;;) {
      TimeTag.lastIndex = pos;
      const m = TimeTag.exec(line);
      if (!m) break;
      times.push(secs(m)); pos = TimeTag.lastIndex;
    }
    if (!times.length) continue;
    let body = line.slice(pos);
    let words = null;
    const wm = [...body.matchAll(WordTagG)];
    if (wm.length) {
      words = [];
      for (let i = 0; i < wm.length; i++) {
        const start = wm[i].index + wm[i][0].length;
        const end = i + 1 < wm.length ? wm[i + 1].index : body.length;
        const w = body.slice(start, end);
        if (w.length) words.push({ t: secs(wm[i]) - offset, w });
      }
      body = body.replace(WordTagG, '');
    }
    body = body.trim();
    for (const t of times) lines.push({ t: Math.max(0, t - offset), text: body, words: times.length === 1 ? words : null });
  }
  lines.sort((a, b) => a.t - b.t);
  const merged = [];
  for (const l of lines) {
    const prev = merged[merged.length - 1];
    if (prev && Math.abs(prev.t - l.t) < 0.011 && prev.trans == null && l.text.length && prev.text.length) prev.trans = l.text;
    else merged.push(l);
  }
  const result = [];
  for (const l of merged) {
    if (!l.text.length && (result.length === 0 || !result[result.length - 1].text.length)) { if (result.length) continue; }
    result.push(l);
  }
  while (result.length && !result[result.length - 1].text.length) result.pop();
  return result;
}
const plain = text => text.replace(/\r\n?/g, '\n').split('\n').map(s => s.trim()).filter(s => !Meta.test(s)).map(s => ({ t: -1, text: s.replace(TimeTagG, '').trim() }));
function mergeTranslation(lines, trans) {
  if (!trans || !trans.length) return;
  for (const l of lines) {
    if (!l.text.length || l.trans != null) continue;
    const hit = trans.find(t => Math.abs(t.t - l.t) < 0.35 && t.text.length);
    if (hit && hit.text !== l.text) l.trans = hit.text;
  }
}

class LyricsService {
  constructor(settings) { this.s = settings; this.inflight = new Map(); }
  /** v2: stricter length matching, manual choices (old caches are fetched again) */
  cachePath(t) { return LyricsService.cacheFile(t.id); }
  static cacheFile(id) { return path.join(AppPaths.Lyrics, id + '.v2.json'); }

  /** Look up lyrics for every track (local files and cache first, online only when needed). */
  async fetchAll(tracks, progress, signal) {
    const list = tracks.slice();
    let done = 0, found = 0;
    progress && progress({ done: 0, total: list.length, found: 0 });
    for (const t of list) {
      if (signal && signal.aborted) break;
      const had = fs.existsSync(this.cachePath(t));
      const r = await this.get(t);
      if (r.lines.length || r.instrumental) found++;
      done++;
      if (done % 5 === 0 || done === list.length) progress && progress({ done, total: list.length, found });
      if (!had && fs.existsSync(this.cachePath(t))) await sleep(350);
    }
  }

  /** All plausible matches from LRCLIB and NetEase, without the strict length filter, closest first. */
  async candidates(t) {
    const artist = firstArtist(t.artist || t.albumArtist);
    const lrclib = (async () => {
      const arr = await json('https://lrclib.net/api/search?track_name=' + encodeURIComponent(t.title) + '&artist_name=' + encodeURIComponent(artist));
      return (arr || []).filter(e => e.syncedLyrics || e.plainLyrics).map(e => ({ key: 'lrclib:' + e.id, source: 'LRCLIB', title: e.trackName, artist: e.artistName, album: e.albumName, duration: typeof e.duration === 'number' ? e.duration : 0, synced: !!e.syncedLyrics }));
    })().catch(e => { Log.info('LRCLIB candidates: ' + e.message); return []; });
    const netease = (async () => {
      const q = encodeURIComponent((t.title + ' ' + artist).trim());
      const j = await json(`https://music.163.com/api/search/get/web?csrf_token=&hlpretag=&hlposttag=&s=${q}&type=1&offset=0&total=true&limit=12`, { Referer: 'https://music.163.com/' });
      const songs = (j && j.result && j.result.songs) || [];
      return songs.filter(s => similarity(s.name, t.title) >= 0.5).map(s => ({ key: 'ne:' + s.id, source: '網易雲音樂', title: s.name, artist: (s.artists || []).map(a => a.name).join(', '), album: s.album && s.album.name, duration: typeof s.duration === 'number' ? s.duration / 1000 : 0, synced: true }));
    })().catch(e => { Log.info('NetEase candidates: ' + e.message); return []; });
    const list = [...await lrclib, ...await netease];
    for (const c of list) c.diff = t.duration > 0 && c.duration > 0 ? Math.round((c.duration - t.duration) * 10) / 10 : 0;
    const k = c => c.duration > 0 && t.duration > 0 ? Math.abs(c.diff) : 30;
    return list.sort((a, b) => k(a) - k(b) || (a.synced ? 0 : 1) - (b.synced ? 0 : 1)).slice(0, 15);
  }

  /** Download the chosen candidate and pin it as this track's lyrics. */
  async apply(t, key) {
    let r = null;
    if (key.startsWith('lrclib:')) {
      const h = await json('https://lrclib.net/api/get/' + encodeURIComponent(key.slice(7))).catch(() => null);
      if (h && h.syncedLyrics) r = { source: 'LRCLIB', synced: true, lines: parse(h.syncedLyrics) };
      else if (h && h.plainLyrics) r = { source: 'LRCLIB', synced: false, lines: plain(h.plainLyrics) };
    } else if (key.startsWith('ne:')) r = await netEaseLyric(key.slice(3)).catch(() => null);
    if (!r) return null;
    r.instrumental = !!r.instrumental; r.manual = true; r.fetched = new Date().toISOString();
    try { fs.writeFileSync(this.cachePath(t), JSON.stringify(r)); } catch { }
    return r;
  }

  /** "None of these are right": remember it, so the wrong lyrics never come back on their own. */
  clear(t) {
    const r = { source: '已標記為錯誤', synced: false, instrumental: false, lines: [], manual: true, fetched: new Date().toISOString() };
    try { fs.writeFileSync(this.cachePath(t), JSON.stringify(r)); } catch { }
  }
  get(t, refresh = false) {
    if (refresh) try { fs.unlinkSync(this.cachePath(t)); } catch { }
    if (!this.inflight.has(t.id)) {
      const p = this.resolve(t).catch(e => { Log.error('Lyrics', e); return empty(); });
      this.inflight.set(t.id, p);
      p.finally(() => this.inflight.delete(t.id));
    }
    return this.inflight.get(t.id);
  }
  async resolve(t) {
    let plainFallback = null;
    if (t.path) {
      const base = t.path.slice(0, t.path.length - path.extname(t.path).length);
      for (const ext of ['.lrc', '.LRC', '.txt']) {
        const p = base + ext;
        if (!fs.existsSync(p)) continue;
        const text = decodeUnknown(fs.readFileSync(p));
        if (looksSynced(text)) return { source: '本機 LRC', synced: true, lines: parse(text) };
        plainFallback = plainFallback || { source: '本機歌詞', synced: false, lines: plain(text) };
      }
      if (t.codec !== 'DSF' && t.codec !== 'DFF') {
        const emb = await ff.lyrics(t.path);
        if (emb) {
          if (looksSynced(emb)) return { source: '內嵌歌詞', synced: true, lines: parse(emb) };
          plainFallback = plainFallback || { source: '內嵌歌詞', synced: false, lines: plain(emb) };
        }
      }
    }
    const cache = this.cachePath(t);
    if (fs.existsSync(cache)) {
      try {
        const c = JSON.parse(fs.readFileSync(cache, 'utf8'));
        if (c.manual) return c.lines.length ? c : (plainFallback || c);
        if (c.synced && c.lines.length) return c;
        // a previous "not found" is only trusted for a few minutes
        if (c.lines.length || c.instrumental || Date.now() - new Date(c.fetched).getTime() < 10 * 60e3) return plainFallback || c;
      } catch { }
    }
    if (!this.s.onlineLyrics) return plainFallback || empty();
    let online = null;
    try { online = await lrcLib(t); } catch (e) { Log.info('LRCLIB: ' + e.message); }
    if (!online || !online.synced || (this.s.lyricsTranslation && online.lines.every(l => l.trans == null) && likelyForeign(online))) {
      try {
        const ne = await netEase(t);
        if (ne && (!online || (ne.synced && !online.synced) || (ne.synced && ne.lines.some(l => l.trans != null)))) online = ne;
      } catch (e) { Log.info('NetEase: ' + e.message); }
    }
    const result = online || empty();
    result.fetched = new Date().toISOString();
    try { fs.writeFileSync(cache, JSON.stringify(result)); } catch { }
    if (!result.lines.length && plainFallback) return plainFallback;
    if (!result.synced && plainFallback) return plainFallback;
    return result;
  }
}
const empty = () => ({ source: null, synced: false, instrumental: false, lines: [] });

function likelyForeign(r) {
  const all = r.lines.slice(0, 20).map(l => l.text).join('');
  let kana = 0, han = 0, latin = 0;
  for (const ch of all) {
    const c = ch.codePointAt(0);
    if (c >= 0x3040 && c <= 0x30FF) kana++;
    else if (c >= 0x4E00 && c <= 0x9FFF) han++;
    else if (c < 128 && /[a-z]/i.test(ch)) latin++;
  }
  return kana > 5 || latin > han * 2;
}

async function json(url, headers) {
  const res = await http(url, { headers });
  if (!res.ok) return null;
  return res.json();
}

async function lrcLib(t) {
  const artist = firstArtist(t.artist || t.albumArtist);
  let hit = await json('https://lrclib.net/api/get?artist_name=' + encodeURIComponent(artist) + '&track_name=' + encodeURIComponent(t.title) +
    '&album_name=' + encodeURIComponent(t.album || '') + '&duration=' + Math.round(t.duration || 0)).catch(() => null);
  if (!hit || (!hit.syncedLyrics && !hit.instrumental)) {
    const arr = await json('https://lrclib.net/api/search?track_name=' + encodeURIComponent(t.title) + '&artist_name=' + encodeURIComponent(artist)).catch(() => null);
    let best = null, bestDiff = 99;
    for (const e of arr || []) {
      let d = typeof e.duration === 'number' ? Math.abs(e.duration - t.duration) : 50;
      if (t.duration > 0 && d > 2.5) continue;
      if (similarity(e.trackName, t.title) < 0.7) continue;
      if (e.syncedLyrics) d -= 10;
      if (d < bestDiff) { bestDiff = d; best = e; }
    }
    hit = best || hit;
  }
  if (!hit) return null;
  if (hit.instrumental) return { source: 'LRCLIB', synced: false, instrumental: true, lines: [] };
  if (hit.syncedLyrics) return { source: 'LRCLIB', synced: true, lines: parse(hit.syncedLyrics) };
  if (hit.plainLyrics) return { source: 'LRCLIB', synced: false, lines: plain(hit.plainLyrics) };
  return null;
}

async function netEase(t) {
  const artist = firstArtist(t.artist || t.albumArtist);
  const q = encodeURIComponent((t.title + ' ' + artist).trim());
  const hdr = { Referer: 'https://music.163.com/' };
  const j = await json(`https://music.163.com/api/search/get/web?csrf_token=&hlpretag=&hlposttag=&s=${q}&type=1&offset=0&total=true&limit=12`, hdr);
  const songs = j && j.result && j.result.songs;
  if (!songs) return null;
  let bestId = 0, bestScore = 0;
  for (const s of songs) {
    const titleSim = similarity(s.name, t.title);
    const ar = (s.artists || []).map(a => a.name).join(' ');
    const artistSim = !artist ? 0.5 : Math.max(similarity(artist, ar), similarity(artist, ar, false));
    const dur = typeof s.duration === 'number' ? s.duration / 1000 : 0;
    const durScore = t.duration <= 0 || dur <= 0 ? 0.5 : Math.abs(dur - t.duration) <= 1.5 ? 1 : Math.abs(dur - t.duration) <= 3 ? 0.6 : 0;
    if (titleSim < 0.7 || durScore === 0) continue;
    const score = titleSim * 0.45 + artistSim * 0.3 + durScore * 0.25;
    if (score > bestScore) { bestScore = score; bestId = s.id; }
  }
  if (!bestId || bestScore < 0.62) return null;
  return netEaseLyric(bestId);
}

async function netEaseLyric(bestId) {
  const hdr = { Referer: 'https://music.163.com/' };
  const ld = await json(`https://music.163.com/api/song/lyric?id=${bestId}&lv=1&kv=1&tv=-1`, hdr);
  if (!ld) return null;
  const lrc = ld.lrc && ld.lrc.lyric, tl = ld.tlyric && ld.tlyric.lyric;
  if (!lrc || !lrc.trim()) return null;
  if (lrc.includes('纯音乐，请欣赏')) return { source: '網易雲音樂', synced: false, instrumental: true, lines: [] };
  const r = { source: '網易雲音樂', synced: looksSynced(lrc) };
  r.lines = r.synced ? parse(lrc) : plain(lrc);
  r.lines = r.lines.filter((x, i) => !(i < 6 && /^(作词|作曲|编曲|作詞|編曲|制作人|製作)\s*[:：]/.test(x.text)));
  if (tl && tl.trim() && r.synced) mergeTranslation(r.lines, parse(tl));
  return r;
}

module.exports = { LyricsService };

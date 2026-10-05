'use strict';
// Album information from MusicBrainz and Apple Music for the tag editor (port of MetadataService in TagEditor.cs):
// search releases, then one release with its track list.
const { http, similarity, RateGate, Log } = require('./common');

async function fetchJson(url, gate) {
  await gate.wait(true);
  const res = await http(url, { timeout: 20000 });
  if (res.status === 503 || res.status === 429) throw new Error('服務忙碌中，請稍後再試');
  if (!res.ok) return null;
  return res.json();
}
const mb = q => fetchJson('https://musicbrainz.org/ws/2/' + q, RateGate.MusicBrainz);
const apple = q => fetchJson('https://itunes.apple.com/' + q, RateGate.Apple);

const credit = e => ((e && e['artist-credit']) || []).map(c => (c.name || '') + (c.joinphrase || '')).join('').trim();
const yearOf = d => (d && /^\d{4}/.test(d)) ? +d.slice(0, 4) : 0;
const lucene = s => (s || '').replace(/([+\-!(){}\[\]^"~*?:\\/]|&&|\|\|)/g, ' ').trim();
const labelOf = e => ((e && e['label-info']) || []).map(l => l.label && l.label.name).find(Boolean) || null;

async function searchMb(album, artist) {
  const list = [];
  try {
    const q = !album ? `artist:"${lucene(artist)}"` : !artist ? `release:"${lucene(album)}"` : `release:"${lucene(album)}" AND artist:"${lucene(artist)}"`;
    const j = await mb('release/?fmt=json&limit=25&query=' + encodeURIComponent(q));
    for (const e of (j && j.releases) || []) {
      const media = e.media || [];
      const counts = new Map();
      for (const m of media) if (m.format) counts.set(m.format, (counts.get(m.format) || 0) + 1);
      list.push({
        source: 'musicbrainz', id: e.id, country: e.country || null, title: e.title, artist: credit(e), date: e.date || null,
        tracks: e['track-count'] || 0, discs: Math.max(1, media.length),
        format: [...counts].map(([f, n]) => n > 1 ? `${n}×${f}` : f).join(' + '), label: labelOf(e),
        thumb: `https://coverartarchive.org/release/${e.id}/front-250`, score: 0,
      });
    }
  } catch (e) { Log.info('MusicBrainz search failed: ' + e.message); }
  return list;
}

async function searchApple(album, artist, country) {
  const list = [];
  try {
    const term = encodeURIComponent(((artist || '') + ' ' + (album || '')).trim());
    const j = await apple(`search?term=${term}&entity=album&limit=20&country=${country}`);
    for (const e of (j && j.results) || []) {
      if (!e.collectionId) continue;
      list.push({
        source: 'apple', id: String(e.collectionId), country, title: e.collectionName, artist: e.artistName,
        date: e.releaseDate ? e.releaseDate.split('T')[0] : null, tracks: e.trackCount || 0, discs: 0, format: 'Digital',
        label: e.copyright || null, thumb: e.artworkUrl100 ? e.artworkUrl100.replace('100x100bb', '300x300bb') : null, score: 0,
      });
    }
  } catch (e) { Log.info('Apple search failed: ' + e.message); }
  return list;
}

/** Releases matching an album, ranked against the local album (title, artist, track count). */
async function search(album, artist, local, sources) {
  album = (album || '').trim(); artist = (artist || '').trim();
  if (!album && !artist) return [];
  const want = new Set((sources && sources.length ? sources : ['musicbrainz', 'apple']).map(s => s.toLowerCase()));
  const tasks = [];
  if (want.has('musicbrainz')) tasks.push(searchMb(album, artist));
  if (want.has('apple')) { tasks.push(searchApple(album, artist, 'jp')); tasks.push(searchApple(album, artist, 'tw')); }
  const all = (await Promise.all(tasks)).flat();
  const n = local ? local.tracks.length : 0;
  for (const h of all) {
    const ts = !album ? 0.5 : similarity(album, h.title);
    const ars = !artist ? 0.5 : Math.max(similarity(artist, h.artist), similarity(artist, h.artist, false));
    const tc = !n || !h.tracks ? 0.5 : h.tracks === n ? 1 : Math.max(0, 1 - Math.abs(h.tracks - n) / n);
    h.score = Math.round((ts * 0.5 + ars * 0.25 + tc * 0.25) * 1000) / 1000;
  }
  return all.sort((a, b) => b.score - a.score).slice(0, 60);
}

async function getMb(id) {
  const e = await mb(`release/${encodeURIComponent(id)}?fmt=json&inc=recordings+artist-credits+labels+release-groups+genres`);
  if (!e) throw new Error('MusicBrainz 找不到這張專輯');
  const r = { source: 'musicbrainz', id, title: e.title, artist: credit(e), date: e.date || null, year: 0, genre: null, label: labelOf(e), cover: null, coverThumb: null, tracks: [] };
  r.year = yearOf(r.date);
  const rg = e['release-group'] || {};
  const first = yearOf(rg['first-release-date']);
  if (first > 0 && (r.year === 0 || first < r.year)) r.year = first;
  const genres = [...(e.genres || []), ...(rg.genres || [])].sort((a, b) => (b.count || 0) - (a.count || 0));
  const g = (genres.find(x => x.name) || {}).name;
  if (g) r.genre = g[0].toUpperCase() + g.slice(1);
  if (e['cover-art-archive'] && e['cover-art-archive'].front) { r.cover = `https://coverartarchive.org/release/${id}/front-1200`; r.coverThumb = `https://coverartarchive.org/release/${id}/front-250`; }
  else if (rg.id) { r.cover = `https://coverartarchive.org/release-group/${rg.id}/front-1200`; r.coverThumb = `https://coverartarchive.org/release-group/${rg.id}/front-250`; }
  let disc = 0;
  for (const m of e.media || []) {
    disc = m.position > 0 ? m.position : disc + 1;
    for (const t of m.tracks || []) {
      let no = t.position || parseInt(t.number, 10) || 0;
      let artist = credit(t);
      if (!artist && t.recording) artist = credit(t.recording);
      r.tracks.push({ disc, no, title: t.title, artist: artist || r.artist, dur: (t.length || 0) / 1000 });
    }
  }
  return r;
}

async function getApple(id, country) {
  country = ['jp', 'tw', 'us'].includes(country) ? country : 'jp';
  const j = await apple(`lookup?id=${encodeURIComponent(id)}&entity=song&limit=300&country=${country}`);
  const results = (j && j.results) || [];
  const c = results.find(x => x.wrapperType === 'collection');
  if (!c) throw new Error('Apple Music 找不到這張專輯');
  const art = c.artworkUrl100;
  const r = {
    source: 'apple', id, title: c.collectionName, artist: c.artistName, date: c.releaseDate ? c.releaseDate.split('T')[0] : null, year: 0,
    genre: c.primaryGenreName || null, label: c.copyright || null,
    cover: art ? art.replace('100x100bb', '1600x1600bb') : null, coverThumb: art ? art.replace('100x100bb', '300x300bb') : null, tracks: [],
  };
  r.year = yearOf(r.date);
  for (const t of results.filter(x => x.wrapperType === 'track' && x.kind === 'song').sort((a, b) => (a.discNumber - b.discNumber) || (a.trackNumber - b.trackNumber)))
    r.tracks.push({ disc: Math.max(1, t.discNumber || 0), no: t.trackNumber || 0, title: t.trackName, artist: t.artistName, dur: (t.trackTimeMillis || 0) / 1000 });
  return r;
}

const get = (source, id, country) => source === 'apple' ? getApple(id, country) : getMb(id);

module.exports = { search, get };

'use strict';
// A synthetic library in the shape of library.json (windows/Library, mac/app/main/library.js), plus lyrics.
const FAMILY = ['初音ミク', 'Aimer', 'ryo (supercell)', '米津玄師', 'YOASOBI', 'ヨルシカ', '宇多田ヒカル', 'Mili', '澤野弘之', '久石譲', '坂本龍一', 'King Gnu',
  'Bill Evans Trio', 'Miles Davis', 'Daft Punk', 'Radiohead', 'Björk', 'Nujabes', '五月天', '周杰倫', '陳綺貞', '草東沒有派對', '告五人', 'Perfume'];
const WORDS = ['Blue', 'Night', 'Sora', '光', '夏', '夢', 'Echo', 'Rain', '花', '星', 'Wave', 'Tokyo', '海', 'Memory', 'Signal', '風', 'Spiral', '月', 'Letter', '春'];

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

/** { json, albums, tracks }: `albums` albums of 8–14 tracks; trackDur overrides every track's length (seconds). */
function makeLibrary({ albums = 600, seed = 7, trackDur = 0 } = {}) {
  const r = rng(seed), pick = a => a[Math.floor(r() * a.length)];
  const artists = Array.from({ length: Math.max(24, Math.round(albums / 5)) }, (_, i) => i < FAMILY.length ? FAMILY[i] : `${pick(WORDS)} ${pick(WORDS)} ${i}`);
  const A = [], T = [], folders = [];
  const now = 62135596800 + Math.floor(Date.UTC(2026, 10, 1) / 1000);
  for (let i = 0; i < albums; i++) {
    const artist = artists[Math.floor(r() * r() * artists.length)];
    const title = `${pick(WORDS)} ${pick(WORDS)}${r() < .3 ? ' ' + pick(WORDS) : ''} ${i + 1}`;
    const id = 'al' + i.toString(36);
    const year = 1975 + Math.floor(r() * 50);
    const q = r();
    const fmt = q < .1 ? ['DSF', 2822400, 1] : q < .45 ? ['FLAC', 96000, 24] : q < .55 ? ['FLAC', 192000, 24] : q < .9 ? ['FLAC', 44100, 16] : ['MP3', 44100, 0];
    const dir = `D:\\MUSIC\\${artist}\\${title}`;
    folders.push(dir);
    const added = now - Math.floor(r() * 3600 * 24 * 900);
    A.push([id, title, r() < .08 ? `${artist} ; ${pick(artists)}` : artist, year, pick(['J-Pop', 'Vocaloid', 'Jazz', 'Rock', 'Electronic', 'Soundtrack']), added, 1, 0, '', dir]);
    const n = 8 + Math.floor(r() * 7);
    for (let k = 0; k < n; k++) {
      const dur = trackDur || 150 + Math.floor(r() * 180);
      T.push(['t' + i.toString(36) + '_' + k, `${pick(WORDS)}${pick(['の', ' ', ' no ', ''])}${pick(WORDS)} ${k + 1}`, r() < .15 ? `${artist} ; ${pick(artists)}` : artist,
        id, 1, k + 1, dur, fmt[0], fmt[1], fmt[2], year, r() < .3 ? pick(artists) : '', added, folders.length - 1]);
    }
  }
  return { json: { albums: A, tracks: T, folders }, albums: A, tracks: T };
}

/** Lyrics for a track: synced lines every few seconds; `mode` 'line' | 'word' | 'plain' | 'none'. */
function makeLyrics(id, dur, mode = 'line') {
  if (mode === 'none') return { id, synced: false, lines: [], offset: 0, source: 'LRCLIB' };
  const r = rng([...id].reduce((a, c) => a * 31 + c.charCodeAt(0) | 0, 7));
  const lines = [];
  for (let t = 4; t < dur - 3; t += 2.5 + r() * 3.5) {
    const words = Array.from({ length: 3 + Math.floor(r() * 6) }, () => WORDS[Math.floor(r() * WORDS.length)]);
    const line = { t: +t.toFixed(2), text: words.join(' ') };
    if (r() < .5) line.trans = '翻譯：' + words.slice().reverse().join('、');
    if (mode === 'word') { let wt = t; line.words = words.map(w => { const x = { t: +wt.toFixed(2), w: w + ' ' }; wt += 0.35 + r() * 0.3; return x; }); }
    if (r() < .06) { line.text = ''; delete line.trans; delete line.words; }
    lines.push(line);
  }
  if (mode === 'plain') return { id, synced: false, lines: lines.map(l => ({ t: 0, text: l.text })), offset: 0, source: 'LRCLIB' };
  return { id, synced: true, lines, offset: 0, source: 'LRCLIB' };
}
module.exports = { makeLibrary, makeLyrics };

#!/usr/bin/env node
// Makes wwwroot/search-dict.js, the offline data romaji / character-variant search uses (see wwwroot/search-ja.js):
//   w  words with kanji → romaji      (IPADIC: nouns, names, places…; only the ones the kanji readings below don't
//                                       already give, which keeps the file small)
//   s  verb / adjective stems → romaji (駆け → kake, used when kana follow)
//   k  kanji → on reading, kun reading, reading on its own (KANJIDIC + IPADIC)
//   v  character → its common form (OpenCC: Simplified, Taiwan / Hong Kong variants and Japanese shinjitai → Traditional)
// Sources (npm): mecab-ipadic-seed, kanji-data (KANJIDIC, © EDRDG, CC BY-SA), opencc-js. Unpack them and run:
//   node windows/make-search-dict.js <mecab-ipadic-seed/package> <kanji-data/package> <opencc-js/package>
'use strict';
const fs = require('fs'), path = require('path');
const [ipaDir, kanjiDir, ccDir] = process.argv.slice(2);
if (!ccDir) { console.error('usage: make-search-dict.js <mecab-ipadic-seed> <kanji-data> <opencc-js>'); process.exit(1); }
const J = require('./wwwroot/search-ja.js');

const HAN = /^[\p{Script=Han}]/u, HAS_HAN = /\p{Script=Han}/u;
const hira = s => s.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
const D = { words: new Map(), stems: new Map(), kanji: new Map(), vars: new Map(), maxLen: 12 };
J._use(D);
const romaji = kana => J.key(hira(kana)).key;

// ── IPADIC ──
const words = new Map(), stems = new Map(), alone = new Map();
const keep = (map, s, r, cost) => { const o = map.get(s); if (!o || cost < o[1]) map.set(s, [r, cost]); };
const dictDir = path.join(ipaDir, 'lib', 'dict');
for (const f of fs.readdirSync(dictDir).filter(f => f.endsWith('.csv'))) {
  if (/^(Symbol|Noun\.number|Noun\.org|Noun\.place)\.csv$/.test(f)) continue;  // place and company names: rare in music, half the size
  for (const line of fs.readFileSync(path.join(dictDir, f), 'utf8').split('\n')) {
    const r = line.split(',');
    if (r.length < 12) continue;
    const surface = hira(r[0]), cost = +r[3], reading = r[11];
    if (!HAN.test(surface) || !reading || reading === '*') continue;
    if (/^(Verb|Adj)\.csv$/.test(f)) {
      if (r[9] !== '基本形') continue;
      const s = surface.slice(0, -1), rd = hira(reading).slice(0, -1);
      if (!HAS_HAN.test(s) || hira(reading).slice(-1) !== surface.slice(-1)) continue;
      keep(stems, s, [romaji(rd), surface, romaji(hira(reading))], cost);
    } else if ([...surface].length === 1) {
      if (/^Noun/.test(f)) keep(alone, surface, romaji(reading), cost);
    } else keep(words, surface, romaji(reading), cost);
  }
}

// ── kanji readings ──
const meta = JSON.parse(fs.readFileSync(path.join(kanjiDir, 'data', 'kanji-meta.json'), 'utf8'));
for (const [c, m] of Object.entries(meta)) {
  const on = (m.on_readings || [])[0], kun = (m.kun_readings || []).find(k => !k.startsWith('-'));
  const a = alone.get(c);
  if (!on && !kun && !a) continue;
  D.kanji.set(c, [on ? romaji(on.replace(/-/g, '')) : '', kun ? romaji(kun.split('.')[0].replace(/-/g, '')) : '', a ? a[0] : '']);
}
for (const [c, a] of alone) if (!D.kanji.has(c)) D.kanji.set(c, ['', '', a[0]]);

// ── words: shortest first, kept only when the dictionary so far reads them differently (with every verb stem in
// place, so that a stem can't take over a word that was left out: 残酷な is not 残 + 酷い) ──
for (const [s, [[r]]] of stems) D.stems.set(s, r);
const sorted = [...words].sort((a, b) => a[0].length - b[0].length || a[1][1] - b[1][1]);
for (const [s, [r]] of sorted) {
  if (s.length > 12) continue;
  if (J.key(s).key === r && J.key(s + 'の').key === r + 'no') continue;
  D.words.set(s, r); J._use(D);
}
// then the stems the words and kanji readings already read right
for (const [s, [[r, base, full]]] of [...stems].sort((a, b) => b[0].length - a[0].length)) {
  D.stems.delete(s); J._use(D);
  if (J.key(base).key !== full) { D.stems.set(s, r); J._use(D); }
}

// ── character variants ──
const cc = name => {
  const src = fs.readFileSync(path.join(ccDir, 'dist', 'esm-lib', 'dict', name + '.js'), 'utf8');
  const body = src.slice(src.indexOf('"') + 1, src.lastIndexOf('"'));
  return body.split('|').map(e => e.split(' ')).filter(e => e.length > 1);
};
const to = new Map();
const add = (a, b) => { if (a !== b && a.length === 1 && b.length === 1 && !to.has(a)) to.set(a, b); };
for (const [s, t] of cc('STCharacters')) add(s, t);              // 体 → 體
for (const [j, t] of cc('JPShinjitaiCharacters')) add(j, t);     // shinjitai → traditional
for (const [v, t] of cc('TWVariantsRev')) add(v, t);
for (const [v, t] of cc('HKVariantsRev')) add(v, t);
const canon = c => { const seen = new Set(); while (to.has(c) && !seen.has(c)) { seen.add(c); c = to.get(c); } return c; };
let v = '';
for (const c of to.keys()) { const t = canon(c); if (t !== c && t.length === 1) v += c + t; }

// ── write ──
const join = m => [...m].map(([a, b]) => a + ' ' + b).join('|');
const k = [...D.kanji].map(([c, r]) => [c, ...r].join(' ').replace(/ +$/, '')).join('|');
const out = '// Generated by windows/make-search-dict.js: data for search-ja.js. IPADIC (© NAIST, see its license), KANJIDIC\n'
  + '// (© Electronic Dictionary Research and Development Group, CC BY-SA 4.0), OpenCC (Apache 2.0).\n'
  + 'window.MIKU_SEARCH_DICT = ' + JSON.stringify({ w: join(D.words), s: join(D.stems), k, v }).replace(/","/g, '",\n"') + ';\n';
fs.writeFileSync(path.join(__dirname, 'wwwroot', 'search-dict.js'), out);
console.log(`words ${D.words.size}/${words.size}, stems ${D.stems.size}/${stems.size}, kanji ${D.kanji.size}, variants ${v.length / 2}, ${(Buffer.byteLength(out) / 1024).toFixed(0)} KB`);

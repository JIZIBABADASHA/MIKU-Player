// Search helpers for Japanese, Korean and Chinese names (used by the search page in views.js):
// - romaji: "yoru ni kakeru", "itaiitsukara" or "i ta i i tsu ka ra" finds 夜に駆ける / 一体いつから. Each name gets a
//   romaji key once (cached); kanji are read with the dictionary in search-dict.js (IPADIC words + KANJIDIC readings).
//   Keys and what is typed are both folded the same loose way: spaces, doubled consonants (っ) and long vowels (ー, ou,
//   ei…) are ignored, and shi/si, chi/ti, tsu/tu, fu/hu, ji/zi… are the same.
//   Korean names get a romaji key too (사랑해 saranghae).
// - character variants: Traditional, Simplified and Japanese forms are the same character (體 = 体, 愛 = 爱).
// Also loaded by mac/build (node) to make search-dict.js, so it must not touch the page.
(function (root) {
  'use strict';
  const SMALL = { 'ゃ': 'ya', 'ゅ': 'yu', 'ょ': 'yo', 'ぁ': 'a', 'ぃ': 'i', 'ぅ': 'u', 'ぇ': 'e', 'ぉ': 'o', 'ゎ': 'wa' };
  const KANA = {
    'あ': 'a', 'い': 'i', 'う': 'u', 'え': 'e', 'お': 'o', 'か': 'ka', 'き': 'ki', 'く': 'ku', 'け': 'ke', 'こ': 'ko',
    'さ': 'sa', 'し': 'si', 'す': 'su', 'せ': 'se', 'そ': 'so', 'た': 'ta', 'ち': 'ti', 'つ': 'tu', 'て': 'te', 'と': 'to',
    'な': 'na', 'に': 'ni', 'ぬ': 'nu', 'ね': 'ne', 'の': 'no', 'は': 'ha', 'ひ': 'hi', 'ふ': 'hu', 'へ': 'he', 'ほ': 'ho',
    'ま': 'ma', 'み': 'mi', 'む': 'mu', 'め': 'me', 'も': 'mo', 'や': 'ya', 'ゆ': 'yu', 'よ': 'yo',
    'ら': 'ra', 'り': 'ri', 'る': 'ru', 'れ': 're', 'ろ': 'ro', 'わ': 'wa', 'ゐ': 'i', 'ゑ': 'e', 'を': 'o', 'ん': 'n',
    'が': 'ga', 'ぎ': 'gi', 'ぐ': 'gu', 'げ': 'ge', 'ご': 'go', 'ざ': 'za', 'じ': 'zi', 'ず': 'zu', 'ぜ': 'ze', 'ぞ': 'zo',
    'だ': 'da', 'ぢ': 'zi', 'づ': 'zu', 'で': 'de', 'ど': 'do', 'ば': 'ba', 'び': 'bi', 'ぶ': 'bu', 'べ': 'be', 'ぼ': 'bo',
    'ぱ': 'pa', 'ぴ': 'pi', 'ぷ': 'pu', 'ぺ': 'pe', 'ぽ': 'po', 'ゔ': 'vu', 'ゕ': 'ka', 'ゖ': 'ke',
    'ゃ': 'ya', 'ゅ': 'yu', 'ょ': 'yo', 'ぁ': 'a', 'ぃ': 'i', 'ぅ': 'u', 'ぇ': 'e', 'ぉ': 'o', 'ゎ': 'wa',
  };
  // kana + small kana that read as one sound (しゃ sya, ふぁ ha, てぃ ti, うぉ o…)
  const PAIR = { 'てぃ': 'ti', 'でぃ': 'di', 'とぅ': 'tu', 'どぅ': 'du', 'うぃ': 'wi', 'うぇ': 'we', 'うぉ': 'o', 'ゔぁ': 'va', 'ゔぃ': 'vi', 'ゔぇ': 've', 'ゔぉ': 'vo', 'つぁ': 'tua', 'しぇ': 'sye', 'ちぇ': 'tye', 'じぇ': 'zye' };
  const HAN = /[\p{Script=Han}々〆ヶ]/u, HIRA = /[ぁ-ゟ]/, CJK = /[\p{Script=Han}ぁ-ヿ가-힣]/u;

  let D = null;
  function dict() {
    if (D) return D;
    const raw = root.MIKU_SEARCH_DICT || {};
    const words = new Map(), stems = new Map(), kanji = new Map();
    let maxLen = 1;
    const pairs = (s, map) => { for (const e of (s || '').split('|')) { const k = e.indexOf(' '); if (k > 0) { const w = e.slice(0, k); map.set(w, e.slice(k + 1)); if (w.length > maxLen) maxLen = w.length; } } };
    pairs(raw.w, words); pairs(raw.s, stems);
    for (const e of (raw.k || '').split('|')) { const [c, on, kun, alone] = e.split(' '); if (c) kanji.set(c, [on || '', kun || '', alone || '']); }
    return (D = { words, stems, kanji, vars: variants(), maxLen: Math.min(maxLen, 12) });
  }
  // the character forms are read on their own (small), so a search in Chinese doesn't load the readings
  let V = null;
  function variants() {
    if (V) return V;
    V = new Map();
    const v = (root.MIKU_SEARCH_DICT || {}).v || '';
    for (let i = 0; i + 1 < v.length; i += 2) V.set(v[i], v[i + 1]);
    return V;
  }

  // Traditional / Simplified / Japanese forms → one form (same length, so positions still match the name shown)
  function vfold(s) {
    if (!s || /^[\x00-\x7f]*$/.test(s)) return s || '';
    const vars = D ? D.vars : variants();
    let out = '', changed = false;
    for (const c of s) { const r = vars.get(c); if (r) { out += r; changed = true; } else out += c; }
    return changed ? out : s;
  }

  // the loose spelling both sides are compared in: voiced and unvoiced sounds are the same (桜 sakura in 千本桜
  // senbonzakura), so are wa and ha (the particle は); a letter that repeats the one before (っ, ー, aa, nn), the u of
  // ou and the i of ei are dropped; m before b / m / p is n
  const LOOSE = { g: 'k', z: 's', d: 't', b: 'h', p: 'h', v: 'h', w: 'h', l: 'r' };
  function squeeze(chars, src) {
    const out = [], at = [];
    for (let i = 0; i < chars.length; i++) {
      let c = chars[i];
      const prev = out.length ? out[out.length - 1] : '';
      if (c === 'm' && /[bmp]/.test(chars[i + 1] || '')) c = 'n';
      c = LOOSE[c] || c;
      if (c === prev && /[a-z]/.test(c)) continue;
      if ((prev === 'o' && c === 'u') || (prev === 'e' && c === 'i')) continue;
      out.push(c); if (src) at.push(src[i]);
    }
    return src ? { key: out.join(''), src: Uint32Array.from(at) } : out.join('');
  }

  // what was typed → the same spelling as the keys (Hepburn, Kunrei or a mix all work)
  const MARKS = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g');  // ō → o
  function foldQuery(q) {
    return squeeze(canon((q || '').normalize('NFKD').replace(MARKS, '').toLowerCase().replace(/[^a-z0-9]/g, '')).split(''));
  }
  function canon(s) {
    return s.replace(/tch/g, 'tty').replace(/sh/g, 'sy').replace(/ch/g, 'ty').replace(/ts/g, 't').replace(/dz/g, 'z').replace(/j/g, 'zy')
      .replace(/f/g, 'h').replace(/wo/g, 'o').replace(/c(?=t)/g, 't').replace(/yy+/g, 'y').replace(/([stz])yi/g, '$1i');
  }

  // Korean: Revised Romanization, syllable by syllable (사랑해 saranghae, 봄 bom)
  const KO_L = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
  const KO_V = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];
  const KO_T = ['', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'k', 'm', 'l', 'l', 'l', 'p', 'l', 'm', 'p', 'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't'];
  // a final consonant before a syllable that starts with a vowel is read with it (좋은 joeun, 사람이 sarami)
  const KO_LINK = ['', 'g', 'kk', 'gs', 'n', 'nj', 'n', 'd', 'r', 'lg', 'lm', 'lb', 'ls', 'lt', 'lp', 'r', 'm', 'b', 'bs', 's', 'ss', 'ng', 'j', 'ch', 'k', 't', 'p', ''];
  function hangul(code, next) {
    const n = code - 0xac00, t = n % 28;
    const link = next >= 0xac00 && next <= 0xd7a3 && Math.floor((next - 0xac00) / 588) === 11;
    return canon(KO_L[Math.floor(n / 588)] + KO_V[Math.floor((n % 588) / 28)] + (link ? KO_LINK[t] : KO_T[t]));
  }

  // a name → its romaji key, and for each letter of the key the index in the name it came from
  const cache = new Map();
  function key(text) {
    text = text || '';
    let r = cache.get(text);
    if (r) return r;
    if (cache.size > 200000) cache.clear();
    const d = dict();
    const units = [];  // [char (hiragana for kana), index in text, was katakana]
    let idx = 0;
    for (const ch of text) {
      for (let c of ch.normalize('NFKC').toLowerCase()) {
        const code = c.charCodeAt(0);
        const kata = code >= 0x30a1 && code <= 0x30f6;
        if (kata) c = String.fromCharCode(code - 0x60);
        units.push([c, idx, kata]);
      }
      idx += ch.length;
    }
    const out = [], src = [], amb = [];
    const emit = (s, from, to) => { for (let k = 0; k < s.length; k++) { out.push(s[k]); src.push(from + Math.floor(k * (to - from) / s.length)); } };
    const isHan = u => !!u && HAN.test(u[0]);
    const isHira = u => !!u && !u[2] && HIRA.test(u[0]) && u[0] !== 'ー';
    let lastKanji = '';
    for (let p = 0; p < units.length;) {
      const u = units[p], c = u[0];
      if (isHan(u) && c !== '々' && c !== 'ヶ') {
        // the longest dictionary word from here; a verb / adjective stem only when kana follow it (駆け|る, 美し|い)
        let best = null, bestLen = 0;
        let s = '';
        for (let n = 1; n <= d.maxLen && p + n <= units.length; n++) {
          s += units[p + n - 1][0];
          const w = d.words.get(s);
          if (w !== undefined && n >= bestLen) { best = w; bestLen = n; }
          const st = d.stems.get(s);
          if (st !== undefined && n >= bestLen && isHira(units[p + n])) { best = st; bestLen = n; }
        }
        if (best !== null) {
          const to = p + bestLen < units.length ? units[p + bestLen][1] : text.length;
          emit(best, u[1], to); lastKanji = best; p += bestLen; continue;
        }
        // not in the dictionary: one kanji at a time, its on reading in a compound, else the word it is on its own
        // (夜 yoru) or its kun reading
        const [on, kun, alone] = d.kanji.get(c) || ['', '', ''];
        const inCompound = isHan(units[p - 1]) || isHan(units[p + 1]);
        const rd = inCompound ? (on || kun || alone) : (alone || kun || on);
        const to = p + 1 < units.length ? units[p + 1][1] : text.length;
        // the other readings make extra keys (千本桜 senbon-o / senbon-sakura), for a few such kanji per name
        const alts = [...new Set([on, kun, alone])].filter(r => r && r !== rd);
        if (alts.length && amb.length < 3) amb.push({ at: out.length, len: rd.length, from: u[1], to, alts });
        emit(rd, u[1], to); lastKanji = rd; p++; continue;
      }
      if (c === '々' || c === 'ヶ' || c === '〆') {
        const rd = c === '々' ? lastKanji : c === 'ヶ' ? 'ka' : 'sime';
        emit(rd, u[1], p + 1 < units.length ? units[p + 1][1] : text.length); p++; continue;
      }
      if (HIRA.test(c) || c === 'ー') {
        const next = units[p + 1];
        const two = next && c + next[0];
        let rd, n = 1;
        if (two && PAIR[two]) { rd = PAIR[two]; n = 2; }
        else if (next && SMALL[next[0]] && /[きしちにひみりぎじぢびぴ]/.test(c)) {
          const base = KANA[c];
          const sm = SMALL[next[0]];
          rd = (/^(si|ti|zi)$/.test(base) ? base[0] + 'y' : base.slice(0, -1) + 'y') + sm.slice(-1); n = 2;
        } else if (next && /[ぁぃぅぇぉ]/.test(next[0]) && /[ふゔ]/.test(c)) { rd = (c === 'ふ' ? 'h' : 'v') + SMALL[next[0]]; n = 2; }
        else if (c === 'っ' || c === 'ー') rd = '';
        else if ((c === 'は' || c === 'へ') && !u[2] && p > 0 && (isHan(units[p - 1]) || units[p - 1][2]) && (!next || !isHira(next))) rd = c === 'は' ? 'wa' : 'e';  // a particle: 君の名は, 夜は短し
        else rd = KANA[c] || '';
        const to = p + n < units.length ? units[p + n][1] : text.length;
        emit(rd, u[1], to); p += n; continue;
      }
      const code = c.charCodeAt(0);
      if (code >= 0xac00 && code <= 0xd7a3) emit(hangul(code, units[p + 1] ? units[p + 1][0].charCodeAt(0) : 0), u[1], u[1] + 1);
      else if (/[a-z0-9]/.test(c)) emit(c, u[1], u[1] + 1);
      p++;
    }
    r = squeeze(out, src);
    r.alts = [];
    for (const a of amb) for (const alt of a.alts) {
      if (r.alts.length >= 4) break;
      const o = out.slice(), sr = src.slice(), add = [], addSrc = [];
      for (let k = 0; k < alt.length; k++) { add.push(alt[k]); addSrc.push(a.from + Math.floor(k * (a.to - a.from) / alt.length)); }
      o.splice(a.at, a.len, ...add); sr.splice(a.at, a.len, ...addSrc);
      r.alts.push(squeeze(o, sr));
    }
    cache.set(text, r);
    return r;
  }
  // every key of a name: the main one first, then the ones with other kanji readings
  const keys = text => { const k = key(text); return k.alts.length ? [k, ...k.alts] : [k]; };

  // where `q` (already folded) is in `text`: [start, end) in the text, or null
  function find(text, q) {
    if (!q) return null;
    const k = keys(text).find(k => k.key.includes(q));
    if (!k) return null;
    const i = k.key.indexOf(q);
    const a = k.src[i], last = k.src[i + q.length - 1];
    // the end: the next letter's source, or the end of the char the last letter came from
    let b = text.length;
    for (let j = i + q.length; j < k.src.length; j++) if (k.src[j] > last) { b = k.src[j]; break; }
    if (b === text.length) { const m = /[\s　・,，、。！？!?「」『』()（）\-~〜]/.exec(text.slice(last + 1)); if (m) b = last + 1 + m.index; }
    return [a, Math.max(b, a + 1)];
  }

  const hasJa = s => !!s && CJK.test(s);
  const api = { key, keys, find, foldQuery, vfold, hasJa, _dict: dict, _use(d) { D = d; cache.clear(); } };
  root.SearchJa = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

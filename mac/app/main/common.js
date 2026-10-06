'use strict';
// Shared helpers: paths, logging, JSON storage, text matching (port of Common.cs)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const Root = app.getPath('userData'); // ~/Library/Application Support/MIKU
const Cache = path.join(app.getPath('cache'), 'MIKU'); // ~/Library/Caches/MIKU
const AppPaths = {
  Root,
  Art: path.join(Root, 'Art'),
  OnlineArt: path.join(Root, 'Art', 'Online'),
  Override: path.join(Root, 'Art', 'Override'),
  Thumbs: path.join(Cache, 'Thumbs'),
  Transcode: path.join(Cache, 'Transcode'),
  Lyrics: path.join(Root, 'Lyrics'),
  Tools: path.join(Root, 'tools'),
  Fingerprints: path.join(Root, 'fingerprints.json'),
  Settings: path.join(Root, 'settings.json'),
  Library: path.join(Root, 'library.json'),
  LogFile: path.join(Root, 'miku.log'),
  AppDir: path.join(__dirname, '..'),
  ensure() {
    for (const d of [this.Root, this.Art, this.OnlineArt, this.Override, this.Thumbs, this.Transcode, this.Lyrics]) fs.mkdirSync(d, { recursive: true });
  },
};

function write(level, msg) {
  try {
    try { const st = fs.statSync(AppPaths.LogFile); if (st.size > 2_000_000) fs.unlinkSync(AppPaths.LogFile); } catch { }
    const d = new Date();
    const ts = d.toISOString().replace('T', ' ').replace('Z', '');
    fs.appendFileSync(AppPaths.LogFile, `${ts} [${level}] ${msg}\n`);
  } catch { }
}
const Log = {
  info: m => write('INFO', m),
  error: (ctx, e) => write('ERROR', ctx + ': ' + (e && e.stack || e)),
};

const Json = {
  load(file, def) {
    try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { Log.error('Load ' + file, e); }
    return def;
  },
  saveAtomic(file, value) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
  },
};

// ───────────── text ─────────────
function hash(s) { return crypto.createHash('sha1').update(s || '', 'utf8').digest('hex').slice(0, 16); }

const Brackets = /[\(\[（【［〔「『<].*?[\)\]）】］〕」』>]/gu;
const NonWord = /[\s\p{P}\p{S}]+/gu;
function norm(s, stripBrackets = false) {
  if (!s || !String(s).trim()) return '';
  s = String(s).normalize('NFKC').toLowerCase();
  if (stripBrackets) {
    const stripped = s.replace(Brackets, ' ');
    if (stripped.replace(NonWord, '').length > 0) s = stripped;
  }
  return s.replace(NonWord, '');
}
function levenshtein(a, b) {
  let prev = new Array(b.length + 1), cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}
function similarity(a, b, stripBrackets = true) {
  a = norm(a, stripBrackets); b = norm(b, stripBrackets);
  if (!a.length || !b.length) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.88 * Math.min(a.length, b.length) / Math.max(a.length, b.length) + 0.12;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

/** Decode a text file of unknown encoding (UTF-8 / UTF-16 / Shift-JIS / Big5 / GBK). */
function decodeUnknown(buf) {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.slice(3).toString('utf8');
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf.slice(2));
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf.slice(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { }
  let best = null, bestScore = -Infinity;
  for (const enc of ['shift_jis', 'big5', 'gbk']) {
    try {
      const s = new TextDecoder(enc, { fatal: true }).decode(buf);
      let score = 0;
      for (const ch of s) {
        const c = ch.codePointAt(0);
        if (c >= 0x3040 && c <= 0x30FF) score += enc === 'shift_jis' ? 3 : -2;
        else if (c >= 0x4E00 && c <= 0x9FFF) score += 1;
        else if (c >= 0xFF61 && c <= 0xFF9F) score -= 2;
        else if (c < 0x20 && c !== 13 && c !== 10 && c !== 9) score -= 5;
      }
      if (score > bestScore) { bestScore = score; best = s; }
    } catch { }
  }
  return best ?? buf.toString('utf8');
}

// Simplified → Traditional (Taiwan) using the OpenCC tables (Windows used LCMapStringEx)
let S2T = null;
function loadS2T() {
  if (S2T) return S2T;
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 's2t.json'), 'utf8'));
  const chars = new Map();
  const cs = [...raw.c];
  for (let i = 0; i + 1 < cs.length; i += 2) chars.set(cs[i], cs[i + 1]);
  for (const k in raw.x) chars.set(k, raw.x[k]);
  const phrases = new Map(Object.entries(raw.p));
  let maxLen = 1;
  for (const k of phrases.keys()) maxLen = Math.max(maxLen, [...k].length);
  S2T = { chars, phrases, maxLen: Math.min(maxLen, 8), tw: new Map(Object.entries(raw.t)) };
  return S2T;
}
function toTraditional(s) {
  if (!s) return s;
  try {
    const t = loadS2T();
    const cs = [...s];
    let out = '';
    for (let i = 0; i < cs.length;) {
      let done = false;
      for (let n = Math.min(t.maxLen, cs.length - i); n >= 2; n--) {
        const p = t.phrases.get(cs.slice(i, i + n).join(''));
        if (p) { out += p; i += n; done = true; break; }
      }
      if (done) continue;
      out += t.chars.get(cs[i]) || cs[i];
      i++;
    }
    return [...out].map(c => t.tw.get(c) || c).join('');
  } catch (e) { Log.error('s2t', e); return s; }
}
function cleanTranslation(s) {
  if (!s || !s.trim()) return null;
  s = s.trim();
  if (s.startsWith('【') && s.endsWith('】')) s = s.slice(1, -1).trim();
  if (s.startsWith('「') && s.endsWith('」') && s.indexOf('「', 1) < 0) s = s.slice(1, -1).trim();
  return s.length === 0 ? null : toTraditional(s);
}

// ───────────── network ─────────────
const UA = 'Miku/1.0 (desktop music player)';
async function http(url, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeout || 15000);
  const outer = opts.signal;
  if (outer) { if (outer.aborted) ctl.abort(); else outer.addEventListener('abort', () => ctl.abort(), { once: true }); }
  try {
    const res = await fetch(url, { method: opts.method || 'GET', body: opts.body, headers: { 'User-Agent': UA, Accept: 'application/json, */*', ...(opts.headers || {}) }, signal: ctl.signal, redirect: 'follow' });
    return res;
  } finally { clearTimeout(timer); }
}
async function getJson(url, headers) {
  try {
    const res = await http(url, { headers });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}
async function getBytes(url) {
  const res = await http(url, { timeout: 30000 });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return Buffer.from(await res.arrayBuffer());
}
async function getText(url) {
  const res = await http(url, { timeout: 30000 });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.text();
}

// .NET DateTime ticks (the UI's "added" field is seconds since 0001-01-01)
const TicksEpoch = 621355968000000000n;
const msToTicks = ms => Number(BigInt(Math.round(ms)) * 10000n + TicksEpoch);

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const finish = () => { if (signal) signal.removeEventListener('abort', abort); resolve(); };
  const timer = setTimeout(finish, ms);
  const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('cancelled')); };
  if (signal) { if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); }
});

/** The first of several ';'-separated names that isn't a compilation placeholder (Text.FirstArtist). */
const firstArtist = s => (s || '').split(';').map(x => x.trim()).filter(Boolean).find(n => n !== 'Various Artists' && n !== '未知演出者') || '';

/**
 * Rate limit for an online service (port of RateGate in Common.cs): at most `max` calls in `windowMs` and `spacing`
 * between calls. Calls the user waits for (`user`) go first: background calls wait while one is queued, and use at
 * most `bgMax` of the window.
 */
class RateGate {
  constructor(max, bgMax, windowMs, spacingMs) { this.max = max; this.bgMax = bgMax; this.window = windowMs; this.spacing = spacingMs; this.calls = []; this.last = 0; this.urgent = 0; }
  async wait(user, signal) {
    if (user) this.urgent++;
    try {
      for (;;) {
        if (signal && signal.aborted) throw new Error('cancelled');
        const now = Date.now();
        while (this.calls.length && now - this.calls[0] >= this.window) this.calls.shift();
        let wait;
        if (!user && this.urgent > 0) wait = 250;
        else {
          wait = this.calls.length >= (user ? this.max : this.bgMax) ? this.calls[0] + this.window - now : 0;
          const gap = this.last + this.spacing - now;
          if (gap > wait) wait = gap;
        }
        if (wait <= 0) { this.last = now; this.calls.push(now); return; }
        await sleep(Math.max(20, wait), signal);
      }
    } finally { if (user) this.urgent--; }
  }
}
RateGate.Apple = new RateGate(20, 12, 60000, 200);
RateGate.MusicBrainz = new RateGate(1, 1, 1050, 0);
RateGate.AcoustId = new RateGate(3, 3, 1050, 0);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

module.exports = { AppPaths, Log, Json, hash, norm, similarity, decodeUnknown, toTraditional, cleanTranslation, http, getJson, getBytes, getText, msToTicks, sleep, clamp, firstArtist, RateGate, UA };

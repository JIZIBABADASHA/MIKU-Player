'use strict';
// 聲紋辨識 (port of Fingerprint.cs): a Chromaprint fingerprint of the first two minutes (FFmpeg decodes, fpcalc
// fingerprints) looked up at AcoustID, which answers with MusicBrainz recordings and the releases they are on.
// fpcalc ships inside MIKU.app (Contents/Resources/bin). Fingerprints are kept while the file is unchanged.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { AppPaths, Log, Json, http, RateGate } = require('./common');
const { Ffmpeg } = require('./ffmpeg');

function findFpcalc() {
  const c = [];
  if (process.resourcesPath) c.push(path.join(process.resourcesPath, 'bin', 'fpcalc'));
  c.push(path.join(AppPaths.AppDir, '..', 'bin', 'fpcalc'), path.join(AppPaths.Tools, 'fpcalc'), '/opt/homebrew/bin/fpcalc', '/usr/local/bin/fpcalc', '/usr/bin/fpcalc');
  for (const p of c) { try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { } }
  return null;
}

class FingerprintService {
  constructor(settings) {
    this.s = settings;
    this.cache = new Map(Object.entries(Json.load(AppPaths.Fingerprints, {}) || {}));
    this.lookups = new Map();
    this.dirty = false;
  }
  get hasKey() { return !!(this.s.acoustIdKey && this.s.acoustIdKey.trim()); }
  get fpcalcPath() { return findFpcalc(); }

  async fingerprint(t, signal) {
    let st;
    try { st = fs.statSync(t.path); } catch { throw new Error('找不到檔案'); }
    const c = this.cache.get(t.path);
    if (c && c.size === st.size && c.mtime === st.mtimeMs && c.fp) return c.fp;
    const fpcalc = this.fpcalcPath;
    if (!fpcalc) throw new Error('缺少聲紋元件 fpcalc');
    if (!Ffmpeg.path) throw new Error('找不到 FFmpeg');
    const print = await new Promise((resolve, reject) => {
      const dec = spawn(Ffmpeg.path, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', t.path, '-map', '0:a:0', '-t', '120', '-ac', '2', '-ar', '44100', '-f', 's16le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
      const fp = spawn(fpcalc, ['-json', '-format', 's16le', '-rate', '44100', '-channels', '2', '-length', '120', '-'], { stdio: ['pipe', 'pipe', 'ignore'] });
      const kill = () => { try { dec.kill(); } catch { } try { fp.kill(); } catch { } };
      if (signal) signal.addEventListener('abort', kill, { once: true });
      dec.on('error', e => { kill(); reject(e); });
      fp.on('error', e => { kill(); reject(e); });
      fp.stdin.on('error', () => { });   // fpcalc stops reading after 120 s of audio
      dec.stdout.pipe(fp.stdin);
      let out = '';
      fp.stdout.on('data', d => out += d);
      fp.on('close', () => {
        try { dec.kill(); } catch { }
        if (signal && signal.aborted) return reject(new Error('cancelled'));
        let f = null;
        try { f = JSON.parse(out).fingerprint; } catch { }
        if (!f) reject(new Error('無法分析這個檔案的音訊')); else resolve(f);
      });
    });
    this.cache.set(t.path, { fp: print, size: st.size, mtime: st.mtimeMs });
    this.dirty = true;
    return print;
  }

  saveCache() {
    if (!this.dirty) return;
    this.dirty = false;
    try { Json.saveAtomic(AppPaths.Fingerprints, Object.fromEntries([...this.cache].filter(([p]) => fs.existsSync(p)))); }
    catch (e) { Log.error('Save fingerprints', e); }
  }

  async lookup(fingerprint, duration, signal) {
    const key = fingerprint + '|' + Math.round(duration);
    if (this.lookups.has(key)) return this.lookups.get(key);
    await RateGate.AcoustId.wait(true, signal);
    const body = new URLSearchParams({ client: (this.s.acoustIdKey || '').trim(), format: 'json', duration: String(Math.round(duration)), fingerprint, meta: 'recordings releases tracks' });
    const res = await http('https://api.acoustid.org/v2/lookup', { method: 'POST', body: body.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000, signal });
    let root;
    try { root = JSON.parse(await res.text()); } catch { throw new Error(`AcoustID 沒有回應（HTTP ${res.status}）`); }
    if (root.status && root.status !== 'ok') {
      const err = root.error || {};
      throw new Error(err.code === 4 ? 'AcoustID 金鑰無效，請到設定確認' : 'AcoustID：' + (err.message || '未知錯誤'));
    }
    this.lookups.set(key, root);
    return root;
  }

  /** Fingerprints and looks up the tracks (a few at a time), reporting each; ranks releases by how many they hold. */
  async identify(tracks, progress, signal) {
    if (!this.hasKey) throw new Error('還沒有設定 AcoustID 金鑰');
    progress({ stage: 'tool' });
    if (!this.fpcalcPath) throw new Error('缺少聲紋元件 fpcalc，請重新安裝 MIKU');
    const artistsOf = e => {
      const list = (e && e.artists) || [];
      if (!list.length) return null;
      return list.map((a, i) => (a.name || '') + (a.joinphrase != null ? a.joinphrase : i < list.length - 1 ? ', ' : '')).join('').trim();
    };
    const matches = new Array(tracks.length);
    const releases = new Map(), counts = new Map();
    let next = 0;
    const n = Math.min(4, Math.max(2, Math.floor(require('os').cpus().length / 2)));
    const work = async () => {
      while (next < tracks.length) {
        if (signal && signal.aborted) throw new Error('cancelled');
        const i = next++, t = tracks[i];
        const m = matches[i] = { id: t.id, status: 'none', error: null, score: 0, recording: null, title: null, artist: null, on: {} };
        try {
          progress({ id: t.id, state: 'print' });
          const print = await this.fingerprint(t, signal);
          progress({ id: t.id, state: 'lookup' });
          const root = await this.lookup(print, t.duration, signal);
          const best = (root.results || []).filter(r => (r.recordings || []).length).sort((a, b) => (b.score || 0) - (a.score || 0))[0];
          if (best) {
            m.score = Math.round((best.score || 0) * 1000) / 1000;
            const recs = best.recordings;
            const rec = recs.slice().sort((a, b) => (b.releases || []).length - (a.releases || []).length)[0];
            m.recording = rec.id || null; m.title = rec.title || null; m.artist = artistsOf(rec);
            m.status = m.title ? 'ok' : 'none';
            for (const r of recs)
              for (const rel of r.releases || []) {
                const rid = rel.id;
                if (!rid) continue;
                for (const med of rel.mediums || []) for (const tr of med.tracks || []) m.on[rid] = `${Math.max(1, med.position || 0)}/${tr.position || 0}`;
                if (!(rid in m.on)) m.on[rid] = '';
                if (!releases.has(rid)) {
                  const d = rel.date;
                  const date = d && typeof d === 'object' ? [d.year, d.month, d.day].filter((x, k, a) => a.slice(0, k + 1).every(v => v > 0)).map((x, k) => k ? String(x).padStart(2, '0') : String(x)).join('-') || null : null;
                  releases.set(rid, {
                    id: rid, title: rel.title || null, artist: artistsOf(rel) || m.artist, date, country: rel.country || null,
                    format: [...new Set((rel.mediums || []).map(x => x.format).filter(Boolean))].join(' + '),
                    tracks: rel.track_count || 0, discs: Math.max(1, rel.medium_count || 0), matched: 0,
                  });
                }
              }
            for (const rid of Object.keys(m.on)) counts.set(rid, (counts.get(rid) || 0) + 1);
          }
        } catch (e) {
          if (signal && signal.aborted) throw e;
          m.status = 'error'; m.error = e.message; Log.info(`Identify ${t.path}: ${e.message}`);
        } finally {
          progress({ id: t.id, state: m.status, title: m.title, artist: m.artist, score: m.score, error: m.error });
        }
      }
    };
    await Promise.all(Array.from({ length: n }, work));
    this.saveCache();
    for (const [rid, c] of counts) if (releases.has(rid)) releases.get(rid).matched = c;
    const ranked = [...releases.values()].sort((a, b) => (b.matched - a.matched)
      || ((a.tracks > 0 ? Math.abs(a.tracks - tracks.length) : 999) - (b.tracks > 0 ? Math.abs(b.tracks - tracks.length) : 999))
      || (a.date || '9999').localeCompare(b.date || '9999')).slice(0, 40);
    return { tracks: matches, releases: ranked };
  }
}

module.exports = { FingerprintService };

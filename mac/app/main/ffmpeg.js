'use strict';
// Bundled FFmpeg / FFprobe: tag reading, embedded pictures and decoding formats Chromium can't play.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { AppPaths, Log, hash } = require('./common');

function find(name) {
  const cands = [];
  if (process.resourcesPath) cands.push(path.join(process.resourcesPath, 'bin', name));
  cands.push(path.join(AppPaths.AppDir, '..', 'bin', name));
  cands.push('/opt/homebrew/bin/' + name, '/usr/local/bin/' + name, '/usr/bin/' + name);
  for (const c of cands) { try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { } }
  return null;
}
const Ffmpeg = {
  path: find('ffmpeg'),
  probePath: find('ffprobe'),
  get available() { return !!this.path && !!this.probePath; },
};

function run(exe, args, { timeout = 20000, maxBuffer = 64 * 1024 * 1024, encoding = 'utf8' } = {}) {
  return new Promise((resolve, reject) => {
    if (!exe) return reject(new Error('FFmpeg not found'));
    execFile(exe, args, { timeout, maxBuffer, encoding, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !(stdout && stdout.length)) return reject(err);
      resolve(stdout);
    });
  });
}

async function probe(file) {
  const out = await run(Ffmpeg.probePath, ['-v', 'error', '-show_entries',
    'format=duration,bit_rate:format_tags:stream=codec_type,codec_name,sample_rate,channels,bits_per_raw_sample,bits_per_sample,sample_fmt,bit_rate:stream_disposition=attached_pic:stream_tags',
    '-of', 'json', file]);
  return JSON.parse(out);
}

async function picture(file) {
  try {
    const buf = await run(Ffmpeg.path, ['-v', 'error', '-i', file, '-an', '-map', '0:v:0', '-frames:v', '1', '-c', 'copy', '-f', 'image2pipe', '-'], { encoding: 'buffer', timeout: 15000 });
    return buf && buf.length > 100 ? buf : null;
  } catch { return null; }
}

async function lyrics(file) {
  try {
    const j = await probe(file);
    const tags = Object.assign({}, ...(j.streams || []).map(s => s.tags || {}), (j.format || {}).tags || {});
    for (const k of Object.keys(tags)) {
      const lk = k.toLowerCase();
      if (lk === 'lyrics' || lk.startsWith('lyrics-') || lk === 'unsyncedlyrics' || lk === 'unsynced lyrics' || lk === '©lyr') {
        if (tags[k] && tags[k].trim()) return tags[k];
      }
    }
  } catch { }
  return null;
}

// ───────────── transcoding to FLAC for formats Chromium can't decode ─────────────
const jobs = new Map();
function transcodeTarget(t, dsdRate) {
  let st = null; try { st = fs.statSync(t.path); } catch { }
  const key = hash(t.path + '|' + (st ? st.size + ':' + st.mtimeMs : '') + '|' + (t.isDsd ? dsdRate : 0));
  return path.join(AppPaths.Transcode, key + '.flac');
}

/** Decodes the whole file to a FLAC in the cache (DSD → PCM at the chosen rate). Resolves with its path. */
function transcode(t, dsdRate) {
  const target = transcodeTarget(t, dsdRate);
  if (fs.existsSync(target)) { touch(target); return Promise.resolve(target); }
  if (jobs.has(target)) return jobs.get(target);
  const p = new Promise((resolve, reject) => {
    if (!Ffmpeg.path) return reject(new Error('找不到 FFmpeg，無法播放 ' + (t.codec || '') + ' 格式。'));
    const tmp = target + '.part';
    const args = ['-v', 'error', '-y', '-i', t.path, '-map', '0:a:0', '-vn', '-map_metadata', '-1'];
    if (t.isDsd) args.push('-af', `aresample=${dsdRate}:filter_size=64:cutoff=0.97,volume=-1dB`, '-sample_fmt', 's32', '-bits_per_raw_sample', '24');
    else if ((t.bits || 16) > 16) args.push('-sample_fmt', 's32', '-bits_per_raw_sample', '24');
    else args.push('-sample_fmt', 's16');
    args.push('-c:a', 'flac', '-compression_level', '0', '-f', 'flac', tmp);
    const proc = spawn(Ffmpeg.path, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', d => { if (err.length < 4000) err += d; });
    proc.on('error', e => reject(e));
    proc.on('close', code => {
      if (code === 0 && fs.existsSync(tmp)) { fs.renameSync(tmp, target); resolve(target); cleanup(); }
      else { try { fs.unlinkSync(tmp); } catch { } reject(new Error('無法解碼這個檔案：' + (err.trim().split('\n').pop() || 'ffmpeg ' + code))); }
    });
  });
  jobs.set(target, p);
  p.finally(() => jobs.delete(target)).catch(() => { });
  return p;
}

function touch(f) { try { const n = new Date(); fs.utimesSync(f, n, n); } catch { } }

/** Keeps the transcode cache under ~3 GB (least recently used first). */
function cleanup() {
  try {
    const files = fs.readdirSync(AppPaths.Transcode).filter(f => f.endsWith('.flac')).map(f => {
      const p = path.join(AppPaths.Transcode, f); const s = fs.statSync(p); return { p, size: s.size, t: s.mtimeMs };
    }).sort((a, b) => b.t - a.t);
    let total = 0;
    for (const f of files) { total += f.size; if (total > 3e9) try { fs.unlinkSync(f.p); } catch { } }
  } catch (e) { Log.error('Transcode cleanup', e); }
}

module.exports = { Ffmpeg, probe, picture, lyrics, transcode, transcodeTarget };

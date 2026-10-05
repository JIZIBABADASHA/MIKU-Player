'use strict';
// 轉換格式 / CUE 分軌 — the Mac side of Windows' Library/Converter.cs and Library/Cue.cs (same FFmpeg arguments).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { Log, decodeUnknown } = require('./common');
const { Ffmpeg } = require('./ffmpeg');

const isDsd = t => t.codec === 'DSF' || t.codec === 'DFF';
const isLossy = t => ['MP3', 'AAC', 'OGG', 'OPUS', 'WMA', 'YouTube'].includes(t.codec);
const Lossless = ['flac', 'alac', 'wav'];
const EXT = { flac: '.flac', alac: '.m4a', wav: '.wav', mp3: '.mp3', aac: '.m4a', opus: '.opus' };

function ext(format) { if (!EXT[format]) throw new Error('不支援的格式：' + format); return EXT[format]; }

/** convert.start / cue.split opts → the options with their defaults. */
function options(a) {
  a = a && typeof a === 'object' ? a : {};
  const n = (k, d, lo, hi) => typeof a[k] === 'number' ? Math.min(hi, Math.max(lo, a[k])) : d;
  const s = (k, d) => typeof a[k] === 'string' ? a[k] : d;
  return {
    format: s('format', 'flac'), flacLevel: n('flacLevel', 5, 0, 8), mp3: s('mp3', 'v0'), aacKbps: n('aacKbps', 256, 64, 320), opusKbps: n('opusKbps', 160, 32, 510),
    bits: s('bits', 'keep'), rate: String(a.rate == null ? 'keep' : a.rate), cover: a.cover !== false, albumFolder: a.albumFolder !== false,
  };
}

let encoders = null;
function getEncoders() {
  if (encoders) return Promise.resolve(encoders);
  return new Promise(resolve => {
    if (!Ffmpeg.path) return resolve(encoders = new Set());
    execFile(Ffmpeg.path, ['-hide_banner', '-encoders'], { timeout: 8000, maxBuffer: 4 << 20 }, (err, out) => {
      const set = new Set();
      for (const line of String(out || '').split('\n')) {
        const p = line.trim().split(/\s+/);
        if (p.length >= 2 && p[0].length === 6 && p[0][0] === 'A') set.add(p[1]);
      }
      resolve(encoders = set);
    });
  });
}

/** The formats the page offers, and whether this FFmpeg can make each. */
async function info(trash) {
  const ff = !!Ffmpeg.path;
  const e = ff ? await getEncoders() : new Set();
  const has = (...n) => n.some(x => e.has(x));
  return {
    ffmpeg: ff, trash,
    formats: [
      { id: 'flac', name: 'FLAC', ok: has('flac') }, { id: 'alac', name: 'ALAC', ok: has('alac') }, { id: 'wav', name: 'WAV', ok: has('pcm_s16le') },
      { id: 'mp3', name: 'MP3', ok: has('libmp3lame') }, { id: 'aac', name: 'AAC', ok: has('aac', 'aac_at') }, { id: 'opus', name: 'Opus', ok: has('libopus', 'opus') },
    ],
  };
}

function pictureExt(b) {
  if (!b || b.length < 8) return null;
  if (b[0] === 0xFF && b[1] === 0xD8) return '.jpg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return '.png';
  return null;
}

/**
 * Converts one track into target (which must not exist), written under a temporary name and renamed when FFmpeg
 * finished. progress(0–1). opts.start / opts.length: a part only (CUE); meta: tags instead of the file's own.
 */
async function convert(t, target, o, dsdRate, picture, progress, signal, part = {}) {
  const fmt = o.format, lossless = Lossless.includes(fmt), enc = await getEncoders();
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1'];
  if (part.length > 0) args.push('-ss', String(+part.start.toFixed(6)), '-t', String(+part.length.toFixed(6)));
  args.push('-i', t.path);
  const dur = part.length > 0 ? part.length : t.duration;
  let picFile = null;
  const pext = pictureExt(picture);
  if (o.cover && ['flac', 'mp3', 'alac', 'aac'].includes(fmt) && pext) {
    picFile = path.join(os.tmpdir(), 'miku-cover-' + crypto.randomBytes(5).toString('hex') + pext);
    fs.writeFileSync(picFile, picture);
    args.push('-i', picFile);
  }
  args.push('-map', '0:a:0', '-map_metadata', part.meta ? '-1' : '0');
  if (part.meta) for (const [k, v] of Object.entries(part.meta)) if (v != null && String(v).trim()) args.push('-metadata', `${k}=${v}`);
  if (picFile) args.push('-map', '1:0', '-c:v', 'copy', '-disposition:v:0', 'attached_pic', '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)');
  else args.push('-vn');

  let rate = 0;
  if (o.rate !== 'keep' && +o.rate > 0) rate = +o.rate;
  else if (isDsd(t)) rate = dsdRate > 0 ? dsdRate : 176400;
  let bits = 0;
  if (lossless) {
    const src = isDsd(t) ? 24 : (t.bits > 0 ? t.bits : 16);
    bits = o.bits === '16' ? 16 : o.bits === '24' ? 24 : src <= 16 ? 16 : 24;
  }
  const fewerBits = lossless && bits === 16 && (isDsd(t) || t.bits > 16 || (!(t.bits > 0) && !isLossy(t)));
  const af = [];
  if (isDsd(t)) af.push(`aresample=${rate}:filter_size=64:cutoff=0.97${fewerBits ? ':dither_method=triangular' : ''},volume=-1dB`);
  else if (rate > 0 || fewerBits) af.push('aresample=' + (rate > 0 ? `${rate}:` : '') + 'dither_method=triangular');
  if (af.length) args.push('-af', af.join(','));
  if (rate > 0) args.push('-ar', String(rate));

  switch (fmt) {
    case 'flac':
      args.push('-c:a', 'flac', '-compression_level', String(o.flacLevel), '-sample_fmt', bits === 16 ? 's16' : 's32');
      if (bits === 24) args.push('-bits_per_raw_sample', '24');
      args.push('-f', 'flac'); break;
    case 'alac':
      args.push('-c:a', 'alac', '-sample_fmt', bits === 16 ? 's16p' : 's32p');
      if (bits === 24) args.push('-bits_per_raw_sample', '24');
      args.push('-f', 'ipod'); break;
    case 'wav': args.push('-c:a', bits === 16 ? 'pcm_s16le' : 'pcm_s24le', '-f', 'wav'); break;
    case 'mp3':
      args.push('-c:a', 'libmp3lame', ...({ v2: ['-q:a', '2'], 320: ['-b:a', '320k'], 256: ['-b:a', '256k'], 192: ['-b:a', '192k'] }[o.mp3] || ['-q:a', '0']));
      args.push('-id3v2_version', '3', '-write_id3v1', '0', '-f', 'mp3'); break;
    case 'aac': args.push('-c:a', enc.has('aac_at') ? 'aac_at' : 'aac', '-b:a', o.aacKbps + 'k', '-f', 'ipod'); break;
    case 'opus':
      args.push(...(enc.has('libopus') ? ['-c:a', 'libopus'] : ['-c:a', 'opus', '-strict', '-2']), '-b:a', o.opusKbps + 'k', '-f', 'opus'); break;
    default: throw new Error('不支援的格式：' + fmt);
  }
  const tmp = target + '.miku-part';
  args.push('-y', tmp);
  try {
    await new Promise((resolve, reject) => {
      if (!Ffmpeg.path) return reject(new Error('找不到 FFmpeg'));
      const p = spawn(Ffmpeg.path, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '', buf = '';
      const kill = () => { try { p.kill('SIGKILL'); } catch { } };
      if (signal) { if (signal.aborted) kill(); signal.addEventListener('abort', kill, { once: true }); }
      p.stderr.on('data', d => { err += d; if (err.length > 20000) err = err.slice(-10000); });
      p.stdout.on('data', d => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (line.startsWith('out_time_us=') && dur > 0) { const us = +line.slice(12); if (us >= 0) progress && progress(Math.min(1, Math.max(0, us / 1e6 / dur))); }
        }
      });
      p.on('error', reject);
      p.on('close', code => {
        if (signal && signal.removeEventListener) signal.removeEventListener('abort', kill);
        if (signal && signal.aborted) return reject(Object.assign(new Error('已停止'), { cancelled: true }));
        let size = 0; try { size = fs.statSync(tmp).size; } catch { }
        if (code !== 0 || !size) return reject(new Error(err.trim().split('\n').pop() || 'FFmpeg 結束代碼 ' + code));
        resolve();
      });
    });
    fs.renameSync(tmp, target);
    progress && progress(1);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { }
    try { if (picFile) fs.unlinkSync(picFile); } catch { }
  }
}

/** A folder / file name made safe for the file system. */
function safeName(s) {
  s = String(s || '').replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_').trim().replace(/[. ]+$/, '');
  if (!s) return '_';
  return s.length > 120 ? s.slice(0, 120).trim() : s;
}

// ───────────── CUE sheets ─────────────
const arg = r => { r = r.trim(); if (r.startsWith('"')) { const e = r.lastIndexOf('"'); return e > 0 ? r.slice(1, e) : r.slice(1); } return r; };

function parseCue(file) {
  const cue = { path: file, title: '', performer: '', songwriter: '', date: '', genre: '', tracks: [] };
  const text = decodeUnknown(fs.readFileSync(file));
  let cur = null, music = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^﻿/, '');
    if (!line) continue;
    const sp = line.indexOf(' ');
    const key = (sp < 0 ? line : line.slice(0, sp)).toUpperCase(), rest = sp < 0 ? '' : line.slice(sp + 1);
    switch (key) {
      case 'FILE': {
        const r = rest.trim();
        if (r.startsWith('"')) { const e = r.lastIndexOf('"'); music = e > 0 ? r.slice(1, e) : r.slice(1); }
        else { const e = r.lastIndexOf(' '); music = e > 0 ? r.slice(0, e) : r; }
        break;
      }
      case 'TRACK': {
        const p = rest.trim().split(/\s+/);
        cur = null;
        if (p.length >= 2 && p[1].toUpperCase() !== 'AUDIO') break;
        cur = { no: parseInt(p[0], 10) || cue.tracks.length + 1, fileName: music, title: '', performer: '', songwriter: '', start: -1, length: 0 };
        cue.tracks.push(cur);
        break;
      }
      case 'TITLE': (cur || cue).title = arg(rest); break;
      case 'PERFORMER': (cur || cue).performer = arg(rest); break;
      case 'SONGWRITER': (cur || cue).songwriter = arg(rest); break;
      case 'REM': {
        const s2 = rest.indexOf(' ');
        if (s2 < 0 || cur) break;
        const k = rest.slice(0, s2).toUpperCase(), v = arg(rest.slice(s2 + 1));
        if (k === 'DATE') cue.date = v; else if (k === 'GENRE') cue.genre = v;
        break;
      }
      case 'INDEX': {
        const p = rest.trim().split(/\s+/);
        if (!cur || p.length < 2 || p[0] !== '01') break;
        const m = /^(\d+):(\d+):(\d+)$/.exec(p[1]);
        if (m) cur.start = +m[1] * 60 + +m[2] + +m[3] / 75;   // CD frames: 75 a second
        break;
      }
    }
  }
  cue.tracks = cue.tracks.filter(t => t.start >= 0 && t.fileName);
  return cue;
}

/** The CUE sheet in the album's folder whose marks cut one of its files into several tracks (lengths filled in); null when none. */
function cueForAlbum(al) {
  if (!al || !al.tracks.length) return null;
  const lc = s => s.toLowerCase();
  const dirs = [...new Set(al.tracks.map(t => path.dirname(t.path)))];
  let best = null;
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir).filter(n => /\.cue$/i.test(n)); } catch { continue; }
    for (const n of names) {
      let cue;
      try { cue = parseCue(path.join(dir, n)); } catch (e) { Log.error('CUE ' + n, e); continue; }
      const here = al.tracks.filter(t => lc(path.dirname(t.path)) === lc(dir));
      for (const ct of cue.tracks) {
        const file = path.basename(ct.fileName.replace(/\\/g, '/'));
        const stem = file.replace(/\.[^.]*$/, '');
        ct.source = here.find(t => lc(path.basename(t.path)) === lc(file)) || here.find(t => lc(path.basename(t.path).replace(/\.[^.]*$/, '')) === lc(stem)) || null;
      }
      cue.tracks = cue.tracks.filter(ct => ct.source);
      const bySrc = new Map();
      for (const ct of cue.tracks) (bySrc.get(ct.source) || bySrc.set(ct.source, []).get(ct.source)).push(ct);
      if (![...bySrc.values()].some(l => l.length >= 2)) continue;
      for (const [src, list] of bySrc) {
        list.sort((x, y) => x.start - y.start);
        list.forEach((ct, i) => { ct.length = Math.max(0, (i + 1 < list.length ? list[i + 1].start : src.duration) - ct.start); });
      }
      cue.tracks = cue.tracks.filter(ct => ct.length > 0.05);
      if (!best || cue.tracks.length > best.tracks.length) best = cue;
    }
  }
  return best;
}

module.exports = { ext, options, info, convert, safeName, parseCue, cueForAlbum };

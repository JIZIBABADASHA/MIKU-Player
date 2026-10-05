'use strict';
// Estimates a constant offset between a song and its synced lyrics (port of LyricAlign.cs): the audio, decoded to
// 8 kHz mono and band-passed to the vocal range, becomes an onset-strength curve; the lyric line starts are slid over
// it and the shift where they line up best wins. Only timestamps are used.
const { spawn } = require('child_process');
const { Ffmpeg } = require('./ffmpeg');

const Rate = 8000, Hop = 0.02, MaxShift = 12;

function decode(file) {
  return new Promise((resolve, reject) => {
    if (!Ffmpeg.path) return reject(new Error('FFmpeg not found'));
    const p = spawn(Ffmpeg.path, ['-v', 'error', '-nostdin', '-i', file, '-vn', '-ac', '1', '-ar', String(Rate), '-af', 'highpass=f=200,lowpass=f=3500', '-f', 'f32le', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    p.stdout.on('data', d => chunks.push(d));
    p.on('error', reject);
    p.on('close', () => {
      const b = Buffer.concat(chunks);
      const n = Math.floor(b.length / 4);
      const f = new Float32Array(n);
      for (let i = 0; i < n; i++) f[i] = b.readFloatLE(i * 4);
      resolve(f);
    });
  });
}

function onsets(pcm) {
  const hop = Math.round(Rate * Hop), frameLen = hop * 2;
  const frames = Math.floor((pcm.length - frameLen) / hop);
  const e = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0; const o = i * hop;
    for (let k = 0; k < frameLen; k++) { const v = pcm[o + k]; s += v * v; }
    e[i] = Math.log10(1e-9 + s / frameLen);
  }
  const on = new Float64Array(frames);
  for (let i = 5; i < frames; i++) on[i] = Math.max(0, e[i] - e[i - 5]);
  const avg = 50; let run = 0;
  const out = new Float64Array(frames);
  let max = 0;
  for (let i = 0; i < frames; i++) {
    run += on[i]; if (i >= avg) run -= on[i - avg];
    out[i] = Math.max(0, on[i] - run / Math.min(i + 1, avg));
    if (out[i] > max) max = out[i];
  }
  if (max > 0) for (let i = 0; i < frames; i++) out[i] /= max;
  return out;
}

/** { offset, confidence, ok } (offset: the value for lyricOffsets), or null when the audio can't be analysed. */
async function estimate(track, lineStarts) {
  const starts = [...new Set(lineStarts.filter(t => t > 0))].sort((a, b) => a - b);
  if (starts.length < 4 || !Ffmpeg.path) return null;
  const pcm = await decode(track.path);
  if (!pcm || pcm.length < Rate * 10) return null;
  const onset = onsets(pcm), frames = onset.length;
  const maxS = Math.round(MaxShift / Hop), win = 4;
  const scores = new Float64Array(2 * maxS + 1);
  for (let si = -maxS; si <= maxS; si++) {
    let sum = 0;
    for (const t of starts) {
      const c = Math.round(t / Hop) + si;
      if (c < 0 || c >= frames) continue;
      let best = 0;
      for (let k = Math.max(0, c - win); k <= Math.min(frames - 1, c + win); k++) if (onset[k] > best) best = onset[k];
      sum += best;
    }
    scores[si + maxS] = sum;
  }
  let bi = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[bi]) bi = i;
  const sorted = Array.from(scores).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const shift = (bi - maxS) * Hop;
  const confidence = median > 0 ? scores[bi] / median : 0;
  return { offset: Math.round(-shift * 100) / 100, confidence, ok: confidence >= 1.25 };
}

module.exports = { estimate };

'use strict';
/* MIKU DSP stage (AudioWorklet): parametric EQ, crossfeed, balance, invert, smooth digital volume, metering.
   A straight port of the Windows build's Dsp.cs, processed in 64-bit floating point. */

function biquad(band, rate) {
  const f = Math.min(Math.max(band.fc, 5), rate * 0.49);
  const q = Math.min(Math.max(band.q <= 0 ? 0.707 : band.q, 0.05), 40);
  const A = Math.pow(10, band.gain / 40);
  const w = 2 * Math.PI * f / rate, c = Math.cos(w), s = Math.sin(w);
  const alpha = s / (2 * q), sq = 2 * Math.sqrt(A) * alpha;
  let b0, b1, b2, a0, a1, a2;
  switch ((band.type || 'PK').toUpperCase()) {
    case 'LSC': case 'LS':
      b0 = A * ((A + 1) - (A - 1) * c + sq); b1 = 2 * A * ((A - 1) - (A + 1) * c); b2 = A * ((A + 1) - (A - 1) * c - sq);
      a0 = (A + 1) + (A - 1) * c + sq; a1 = -2 * ((A - 1) + (A + 1) * c); a2 = (A + 1) + (A - 1) * c - sq; break;
    case 'HSC': case 'HS':
      b0 = A * ((A + 1) + (A - 1) * c + sq); b1 = -2 * A * ((A - 1) + (A + 1) * c); b2 = A * ((A + 1) + (A - 1) * c - sq);
      a0 = (A + 1) - (A - 1) * c + sq; a1 = 2 * ((A - 1) - (A + 1) * c); a2 = (A + 1) - (A - 1) * c - sq; break;
    case 'LP': case 'LPQ':
      b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha; break;
    case 'HP': case 'HPQ':
      b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha; break;
    default:
      b0 = 1 + alpha * A; b1 = -2 * c; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * c; a2 = 1 - alpha / A;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, z1l: 0, z2l: 0, z1r: 0, z2r: 0 };
}
const isIdentity = b => !['LP', 'LPQ', 'HP', 'HPQ'].includes((b.type || 'PK').toUpperCase()) && Math.abs(b.gain) < 1e-6;
function magnitude(bq, f, rate) {
  const w = 2 * Math.PI * f / rate;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = bq.b0 + bq.b1 * c1 + bq.b2 * c2, ni = -(bq.b1 * s1 + bq.b2 * s2);
  const dr = 1 + bq.a1 * c1 + bq.a2 * c2, di = -(bq.a1 * s1 + bq.a2 * s2);
  return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
}
function maxBoostDb(filters, rate) {
  if (!filters.length) return 0;
  let max = -Infinity;
  for (let i = 0; i <= 240; i++) {
    const f = 20 * Math.pow(1000, i / 240);
    if (f >= rate * 0.49) break;
    let m = 1;
    for (const b of filters) m *= magnitude(b, f, rate);
    max = Math.max(max, 20 * Math.log10(m));
  }
  return max;
}
function crossfeed(fcut, feedDb, rate) {
  const gbLo = feedDb * -5 / 6 - 3, gbHi = feedDb / 6 - 3;
  const gLo = Math.pow(10, gbLo / 20), gHi = 1 - Math.pow(10, gbHi / 20);
  const fcHi = fcut * Math.pow(2, (gbLo - 20 * Math.log10(gHi)) / 12);
  let x = Math.exp(-2 * Math.PI * fcut / rate);
  const cf = { b1Lo: x, a0Lo: gLo * (1 - x) };
  x = Math.exp(-2 * Math.PI * fcHi / rate);
  Object.assign(cf, { b1Hi: x, a0Hi: 1 - gHi * (1 - x), a1Hi: -x, gain: 1 / (1 - gHi + gLo), loL: 0, loR: 0, hiL: 0, hiR: 0, inL: 0, inR: 0 });
  return cf;
}
function buildGraph(cfg, rate) {
  const g = { filters: [], cf: null, pre: 1, limit: 1, gl: 1, gr: 1, inv: false, active: false };
  if (!cfg || !cfg.enabled) return g;
  const bands = cfg.eqOn ? (cfg.bands || []).filter(b => b.on && !isIdentity(b)) : [];
  g.filters = bands.map(b => biquad(b, rate));
  let pre = cfg.eqOn ? (cfg.preampDb || 0) : 0;
  if (cfg.eqOn && cfg.autoPreamp) {
    pre = 0;
    const boost = Math.max(0, maxBoostDb(g.filters, rate));
    g.limit = boost > 0 ? Math.pow(10, -(boost + 0.1) / 20) : 1;
  }
  g.pre = Math.pow(10, pre / 20);
  if (cfg.crossfeed && cfg.crossfeed.on) g.cf = crossfeed(cfg.crossfeed.fc, cfg.crossfeed.feed, rate);
  const bal = Math.min(1, Math.max(-1, cfg.balance || 0));
  g.gl = bal > 0 ? 1 - bal : 1; g.gr = bal < 0 ? 1 + bal : 1;
  g.inv = !!cfg.invert;
  g.active = g.filters.length > 0 || !!g.cf || Math.abs(pre) > 1e-9 || bal !== 0 || g.inv;
  return g;
}
function run(g, o) {
  let l = o.l * g.pre, r = o.r * g.pre;
  const f = g.filters;
  for (let i = 0; i < f.length; i++) {
    const b = f[i];
    const yl = b.b0 * l + b.z1l; b.z1l = b.b1 * l - b.a1 * yl + b.z2l; b.z2l = b.b2 * l - b.a2 * yl;
    const yr = b.b0 * r + b.z1r; b.z1r = b.b1 * r - b.a1 * yr + b.z2r; b.z2r = b.b2 * r - b.a2 * yr;
    l = yl; r = yr;
  }
  const c = g.cf;
  if (c) {
    c.loL = c.a0Lo * l + c.b1Lo * c.loL; c.loR = c.a0Lo * r + c.b1Lo * c.loR;
    c.hiL = c.a0Hi * l + c.a1Hi * c.inL + c.b1Hi * c.hiL; c.hiR = c.a0Hi * r + c.a1Hi * c.inR + c.b1Hi * c.hiR;
    c.inL = l; c.inR = r;
    l = (c.hiL + c.loR) * c.gain; r = (c.hiR + c.loL) * c.gain;
  }
  l *= g.gl; r *= g.gr;
  if (g.inv) { l = -l; r = -r; }
  o.l = l; o.r = r;
}

const FADE = 2048;
class MikuDsp extends AudioWorkletProcessor {
  constructor() {
    super();
    this.graph = buildGraph(null, sampleRate); this.old = null; this.fade = 0;
    this.gain = 1; this.target = 1;
    this.ramp = 1 - Math.exp(-1 / (0.025 * sampleRate));
    this.pl = 0; this.pr = 0; this.clips = 0; this.blocks = 0;
    this.o = { l: 0, r: 0 }; this.o2 = { l: 0, r: 0 };
    this.port.onmessage = e => {
      const m = e.data;
      if (m.cfg !== undefined) { this.old = this.graph; this.graph = buildGraph(m.cfg, sampleRate); this.fade = FADE; }
      if (m.gain !== undefined) { this.target = Math.max(0, m.gain); if (m.instant) this.gain = this.target; }
    };
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    if (!inp || inp.length === 0) { L.fill(0); if (R !== L) R.fill(0); return true; }
    const iL = inp[0], iR = inp[1] || inp[0];
    const g = this.graph;
    let target = this.target;
    if (g.limit < target) target = g.limit;
    const active = g.active || this.old;
    let pl = this.pl, pr = this.pr;
    const o = this.o, o2 = this.o2;
    for (let i = 0; i < L.length; i++) {
      o.l = iL[i]; o.r = iR[i];
      if (active) {
        o2.l = o.l; o2.r = o.r;
        run(g, o);
        if (this.old) {
          run(this.old, o2);
          const m = this.fade / FADE;
          o.l = o.l * (1 - m) + o2.l * m; o.r = o.r * (1 - m) + o2.r * m;
          if (--this.fade <= 0) this.old = null;
        }
      }
      if (this.gain !== target) {
        this.gain += (target - this.gain) * this.ramp;
        if (Math.abs(this.gain - target) < 1e-7) this.gain = target;
      }
      let l = o.l * this.gain, r = o.r * this.gain;
      const al = Math.abs(l), ar = Math.abs(r);
      if (al > pl) pl = al;
      if (ar > pr) pr = ar;
      if (al >= 1) { this.clips++; l = l > 0 ? 0.99999994 : -1; }
      if (ar >= 1) { this.clips++; r = r > 0 ? 0.99999994 : -1; }
      L[i] = l; if (R !== L) R[i] = r;
    }
    this.pl = pl; this.pr = pr;
    if (++this.blocks >= 16) { // ~45 ms
      this.port.postMessage({ l: this.pl, r: this.pr, clips: this.clips });
      this.pl = 0; this.pr = 0; this.blocks = 0;
    }
    return true;
  }
}
registerProcessor('miku-dsp', MikuDsp);

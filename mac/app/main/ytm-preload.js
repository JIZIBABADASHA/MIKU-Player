'use strict';
// Runs inside the YouTube Music panel: reports what's playing so MIKU can show it, like the Windows build did.
const { ipcRenderer } = require('electron');
let last = 0;
function meta() {
  last = Date.now();
  const v = document.querySelector('video');
  if (!v) return;
  const bar = document.querySelector('ytmusic-player-bar');
  const q = s => bar && bar.querySelector(s);
  const img = q('img.image') || q('img');
  ipcRenderer.send('ytm', { k: 'meta', t: v.currentTime || 0, d: isFinite(v.duration) ? v.duration : 0, p: !v.paused,
    title: ((q('.title') || {}).textContent || '').trim(), by: ((q('.byline') || {}).textContent || '').trim(), img: img ? img.src : '' });
}

// ───────────── audio tap ─────────────
// A playback core that takes MIKU's live track (Daphne) plays this page's audio itself: device, exclusive mode, DSP,
// volume. While MIKU asks for it (ytm-tap), every media element is routed into an AudioContext that renders to no
// device, and an AudioWorklet hands the samples over in blocks, on a port that leads straight to the process that feeds
// the core (live-relay.js), not through MIKU's main process. A busy page can only delay the audio (the core's buffer
// absorbs that), never lose any of it. Without the tap the page plays through the system output as before; a
// page whose elements are already routed is sent to the default device again when the tap is turned off.
let tap = false, ctx = null, node = null, ready = null, kind = '', why = '', out = null;
const hooked = new WeakSet();
const WORKLET = `class MikuTap extends AudioWorkletProcessor {
  constructor() { super(); this.n = 0; this.b = new Float32Array(4096); }
  process(inputs, outputs) {
    const i = inputs[0], o = outputs[0];
    if (i && i.length) {
      const L = i[0], R = i[1] || i[0];
      if (o && o.length) { o[0].set(L); if (o[1]) o[1].set(R); }   // heard only when the context has a device
      for (let k = 0; k < L.length; k++) { this.b[this.n++] = L[k]; this.b[this.n++] = R[k]; }
      if (this.n >= 4096) { this.port.postMessage(this.b, [this.b.buffer]); this.b = new Float32Array(4096); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('miku-tap', MikuTap);`;
const pcm = b => { if (tap && out) out.postMessage(b); };   // (copied: a transferred buffer does not arrive in the relay's process)
ipcRenderer.on('ytm-port', e => { if (out) out.close(); out = e.ports[0] || null; });
function ensure() {
  if (ready) return ready;
  // render without any output device: the page must never open the DAC itself
  try { ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'playback', sinkId: { type: 'none' } }); }
  catch { ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' }); }
  ready = (async () => {
    try {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      node = new AudioWorkletNode(ctx, 'miku-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
      node.port.onmessage = e => pcm(e.data);
      kind = 'worklet';
    } catch (e) {
      why = String((e && e.message) || e);
      // fallback: a main-thread processor with a large buffer, so short stalls do not drop audio
      node = ctx.createScriptProcessor(16384, 2, 2);
      node.onaudioprocess = e => {
        const ib = e.inputBuffer, ob = e.outputBuffer, L = ib.getChannelData(0), R = ib.numberOfChannels > 1 ? ib.getChannelData(1) : L;
        ob.getChannelData(0).set(L); ob.getChannelData(1).set(R);
        const b = new Float32Array(L.length * 2);
        for (let k = 0; k < L.length; k++) { b[2 * k] = L[k]; b[2 * k + 1] = R[k]; }
        pcm(b);
      };
      kind = 'script';
    }
    node.connect(ctx.destination);
    ipcRenderer.send('ytm', { k: 'tap', rate: ctx.sampleRate, sink: ctx.sinkId && ctx.sinkId.type ? 'none' : 'device', kind, why });
  })();
  return ready;
}
async function hook(v) {
  try {
    await ensure();
    if (!hooked.has(v)) { hooked.add(v); ctx.createMediaElementSource(v).connect(node); v.volume = 1; }
    if (ctx.state !== 'running' && !v.paused) await ctx.resume();
  } catch (e) { ipcRenderer.send('ytm', { k: 'tap-error', message: String((e && e.message) || e) }); }
}
// every media element goes into the tap as soon as it is there, before it plays: Chromium then never opens an output
// stream of its own for it
const scan = () => { if (tap) document.querySelectorAll('video, audio').forEach(v => { if (!hooked.has(v) || (!v.paused && ctx && ctx.state !== 'running')) hook(v); }); };
ipcRenderer.on('ytm-tap', async (_e, on) => {
  tap = !!on;
  if (tap) { ensure(); scan(); }
  if (!ctx || typeof ctx.setSinkId !== 'function') return;
  // routed elements stay routed: without the tap they are heard through the default device
  try { await ctx.setSinkId(tap ? { type: 'none' } : ''); } catch { }
});
setInterval(scan, 500);
ipcRenderer.send('ytm', { k: 'hello' });

window.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('play', e => { if (tap && e.target && /VIDEO|AUDIO/.test(e.target.tagName)) hook(e.target); }, true);
  document.addEventListener('play', e => { if (e.target && /VIDEO|AUDIO/.test(e.target.tagName)) { ipcRenderer.send('ytm', { k: 'play' }); setTimeout(meta, 200); } }, true);
  document.addEventListener('pause', e => { if (e.target && /VIDEO|AUDIO/.test(e.target.tagName)) { ipcRenderer.send('ytm', { k: 'pause' }); meta(); } }, true);
  setInterval(() => { if (Date.now() - last > 450) meta(); }, 500);
});

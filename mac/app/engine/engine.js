'use strict';
/* MIKU audio engine (hidden window). Two decks (current + preloaded next) of <audio> → ReplayGain → DSP worklet → Core Audio.
   Commands arrive from the main process; status is reported back about 10× a second. */
const ipc = window.engineIpc;
const send = m => ipc.send(m);

let ctx = null, dsp = null, ready = null, sinkId = '';
const meter = { l: 0, r: 0, clips: 0 };
let underruns = 0;

function makeDeck() {
  const el = new Audio();
  el.crossOrigin = 'anonymous';
  el.preload = 'auto';
  const d = { el, id: null, src: null, gain: null, node: null, seq: 0, pendingSeek: null };
  return d;
}
const decks = [makeDeck(), makeDeck()];
let cur = 0;
const A = () => decks[cur], B = () => decks[1 - cur];
let wantPlay = false;
let nextReady = false;
let loadSeq = 0, contextRunning = false, contextTask = Promise.resolve();

// Serialize hardware state changes so a quick pause/resume cannot leave the context in the wrong state.
function setContextRunning(on) {
  contextRunning = on;
  contextTask = contextTask.catch(() => { }).then(async () => {
    if (!ctx) return;
    if (contextRunning) {
      if (ctx.state !== 'running') await ctx.resume();
    } else {
      if (ctx.state !== 'suspended') await ctx.suspend();
      meter.l = 0; meter.r = 0;
    }
  });
  return contextTask;
}

async function ensure() {
  if (ready) return ready;
  ready = (async () => {
    ctx = new AudioContext({ latencyHint: 'playback' });
    // The engine is initialized at launch, even when no song is playing.
    await ctx.suspend();
    await ctx.audioWorklet.addModule('dsp-worklet.js');
    dsp = new AudioWorkletNode(ctx, 'miku-dsp', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    dsp.port.onmessage = e => { meter.l = e.data.l; meter.r = e.data.r; meter.clips = e.data.clips; };
    dsp.connect(ctx.destination);
    for (const d of decks) {
      d.node = ctx.createMediaElementSource(d.el);
      d.gain = ctx.createGain();
      d.node.connect(d.gain).connect(dsp);
      wire(d);
    }
    if (sinkId) await applySink(sinkId);
  })();
  return ready;
}

function wire(d) {
  d.el.addEventListener('ended', () => { if (d === A()) onEnded(); });
  d.el.addEventListener('waiting', () => { if (d === A() && wantPlay) underruns++; });
  d.el.addEventListener('error', () => {
    if (d !== A() || !d.src) return;
    const code = d.el.error ? d.el.error.code : 0;
    if (d.loading) return; // reported by load()
    wantPlay = false;
    setContextRunning(false).catch(() => { });
    reportStatus();
    send({ e: 'error', id: d.id, code, msg: errText(code) });
  });
  d.el.addEventListener('play', () => { if (d === A() && navigator.mediaSession) navigator.mediaSession.playbackState = 'playing'; });
  d.el.addEventListener('pause', () => { if (d === A() && navigator.mediaSession) navigator.mediaSession.playbackState = 'paused'; });
}
const errText = c => ({ 1: '播放被中止', 2: '讀取檔案時發生錯誤', 3: '解碼失敗', 4: '不支援的格式' })[c] || '播放失敗';

function onEnded() {
  const n = B();
  if (wantPlay && n.src && nextReady && n.el.readyState >= 2) {
    // gapless: start the preloaded deck straight away
    const old = A();
    cur = 1 - cur;
    n.el.play().catch(() => { });
    send({ e: 'started', id: n.id });
    old.el.removeAttribute('src'); old.el.load(); old.src = null; old.id = null;
    nextReady = false;
    meta(n.meta);
  } else {
    wantPlay = false;
    setContextRunning(false).catch(() => { });
    reportStatus();
    send({ e: 'ended' });
  }
}

function waitFor(el, events, timeout) {
  return new Promise(resolve => {
    let done = false;
    const fin = ev => { if (done) return; done = true; clearTimeout(t); for (const e of events) el.removeEventListener(e, h[e]); resolve(ev); };
    const h = {};
    for (const e of events) { h[e] = () => fin(e); el.addEventListener(e, h[e]); }
    const t = setTimeout(() => fin('timeout'), timeout);
  });
}

async function load(m) {
  const seq = ++loadSeq;
  wantPlay = !!m.play;
  await ensure();
  if (seq !== loadSeq) return;
  // drop any preloaded deck: an explicit load always replaces both
  const n = B(); if (n.src) { n.el.pause(); n.el.removeAttribute('src'); n.el.load(); n.src = null; n.id = null; } nextReady = false;
  const d = A();
  d.el.pause();
  d.id = m.id; d.src = m.url; d.meta = m.meta; d.loading = true;
  await setContextRunning(false);
  if (seq !== loadSeq) return;
  d.gain.gain.value = m.rg ?? 1;
  d.el.src = m.url;
  d.el.load();
  const ev = await waitFor(d.el, ['loadedmetadata', 'error'], m.timeout || 120000);
  if (seq !== loadSeq || d.src !== m.url) return; // superseded
  if (ev !== 'loadedmetadata') {
    d.loading = false;
    wantPlay = false;
    await setContextRunning(false);
    const code = d.el.error ? d.el.error.code : 0;
    send({ e: 'loaded', seq: m.seq, ok: false, code, msg: ev === 'timeout' ? '讀取逾時' : errText(code) });
    return;
  }
  if (m.pos > 0) { try { d.el.currentTime = m.pos; } catch { } }
  d.loading = false;
  if (wantPlay) {
    try {
      await setContextRunning(true);
      if (seq !== loadSeq) return;
      if (wantPlay) await d.el.play();
    } catch (err) {
      if (seq !== loadSeq) return;
      wantPlay = false;
      await setContextRunning(false);
      send({ e: 'loaded', seq: m.seq, ok: false, code: 0, msg: String(err && err.message || err) }); return;
    }
  }
  meta(m.meta);
  reportStatus();
  send({ e: 'loaded', seq: m.seq, ok: true, duration: d.el.duration, playing: !d.el.paused && !d.el.ended });
}

async function preload(m) {
  await ensure();
  const n = B();
  nextReady = false;
  n.id = m.id; n.src = m.url; n.meta = m.meta;
  n.gain.gain.value = m.rg ?? 1;
  n.el.src = m.url;
  n.el.load();
  const ev = await waitFor(n.el, ['canplaythrough', 'error'], 180000);
  if (n.src !== m.url) return;
  nextReady = ev === 'canplaythrough';
}

function clearNext() { const n = B(); if (n.src) { n.el.removeAttribute('src'); n.el.load(); n.src = null; n.id = null; } nextReady = false; }

async function applySink(id) {
  sinkId = id || '';
  if (!ctx || typeof ctx.setSinkId !== 'function') return;
  try { await ctx.setSinkId(sinkId === 'default' ? '' : sinkId); }
  catch (e) { send({ e: 'error', msg: '無法切換輸出裝置：' + e.message }); }
}

async function devices() {
  let list = [];
  try { list = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput'); } catch { }
  return list.filter(d => d.deviceId !== 'communications').map(d => ({ id: d.deviceId, name: d.deviceId === 'default' ? (d.label || '系統預設').replace(/^Default - /, '') : (d.label || '輸出裝置'), isDefault: d.deviceId === 'default' }));
}

function meta(m) {
  if (!navigator.mediaSession || !m) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: m.title || '', artist: m.artist || '', album: m.album || '', artwork: m.art ? [{ src: m.art, sizes: '512x512', type: 'image/jpeg' }] : [] });
  } catch { }
}
if (navigator.mediaSession) {
  for (const a of ['play', 'pause', 'nexttrack', 'previoustrack', 'stop']) {
    try { navigator.mediaSession.setActionHandler(a, () => send({ e: 'media', action: a })); } catch { }
  }
  try { navigator.mediaSession.setActionHandler('seekto', d => send({ e: 'media', action: 'seekto', pos: d.seekTime })); } catch { }
}

ipc.on(async m => {
  try {
    switch (m.c) {
      case 'load': await load(m); break;
      case 'preload': await preload(m); break;
      case 'clearNext': clearNext(); break;
      case 'pause': wantPlay = false; A().el.pause(); await setContextRunning(false); reportStatus(); break;
      case 'resume':
        wantPlay = true;
        await ensure();
        if (!wantPlay || !A().src) break;
        await setContextRunning(true);
        if (wantPlay) await A().el.play();
        reportStatus(); break;
      case 'seek': { const d = A(); if (d.src) { try { d.el.currentTime = Math.max(0, m.pos); } catch { } } if (B().src) clearNextIfStale(); break; }
      case 'stop': ++loadSeq; wantPlay = false; for (const d of decks) { d.el.pause(); d.el.removeAttribute('src'); d.el.load(); d.src = null; d.id = null; } nextReady = false; await setContextRunning(false); reportStatus(); break;
      case 'gain': await ensure(); dsp.port.postMessage({ gain: m.v, instant: !!m.instant }); break;
      case 'rg': await ensure(); A().gain.gain.setTargetAtTime(m.v, ctx.currentTime, 0.02); break;
      case 'dsp': await ensure(); dsp.port.postMessage({ cfg: m.cfg }); break;
      case 'sink': await ensure(); await applySink(m.id); send({ e: 'sinkDone', seq: m.seq }); break;
      case 'devices': send({ e: 'devices', seq: m.seq, list: await devices() }); break;
      case 'init': await ensure(); send({ e: 'rate', rate: ctx.sampleRate }); break;
    }
  } catch (e) {
    if (m.c === 'load' || m.c === 'resume') { wantPlay = false; await setContextRunning(false).catch(() => { }); reportStatus(); }
    send({ e: 'error', msg: String(e && e.message || e) });
  }
});
function clearNextIfStale() { /* seeking keeps the preloaded next track */ }

navigator.mediaDevices && navigator.mediaDevices.addEventListener('devicechange', () => send({ e: 'devicechange' }));

let statusTimer = null;
function reportStatus() {
  clearTimeout(statusTimer);
  const d = A();
  const active = !!d.src && !d.el.paused && !d.el.ended;
  if (!active) { meter.l = 0; meter.r = 0; }
  send({
    e: 'status', id: d.id, pos: d.src ? d.el.currentTime : 0, dur: d.src ? d.el.duration : 0,
    playing: active, l: meter.l, r: meter.r, clips: meter.clips, underruns,
    rate: ctx ? ctx.sampleRate : 0, out: ctx ? Math.round(((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000) : 0,
  });
  statusTimer = setTimeout(reportStatus, active ? 100 : 1000);
}
send({ e: 'hello' });
reportStatus();

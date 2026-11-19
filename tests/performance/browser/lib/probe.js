'use strict';
// Runs in the page before any of MIKU's scripts: counts what the page does (timers, animation frames, observers) and
// where it was asked for, without changing what it does. Read through window.__probe.snapshot().
(() => {
  if (window.__probe) return;
  const native = {
    setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window), clearInterval: window.clearInterval.bind(window),
    raf: window.requestAnimationFrame.bind(window), caf: window.cancelAnimationFrame.bind(window),
    MO: window.MutationObserver, RO: window.ResizeObserver, IO: window.IntersectionObserver,
  };
  const P = window.__probe = {
    attribution: true,
    timeout: { set: 0, fired: 0, cleared: 0 }, interval: { set: 0, fired: 0, cleared: 0 }, raf: { requested: 0, fired: 0, cancelled: 0 },
    mo: { made: 0, callbacks: 0, records: 0 }, ro: { made: 0, callbacks: 0, entries: 0 },
    sites: { timeout: new Map(), interval: new Map(), raf: new Map(), mo: new Map(), ro: new Map() },
    liveTimeouts: new Map(), liveIntervals: new Map(), liveRafs: new Set(),
    errors: [],
  };
  // the first frame of the stack outside this file: "file.js:123"
  const here = (document.currentScript && document.currentScript.src) || 'probe.js';
  const where = () => {
    if (!P.attribution) return '';
    const lines = String(new Error().stack || '').split('\n');
    for (let i = 2; i < lines.length; i++) {
      const l = lines[i];
      if (l.includes('__probe') || l.includes(here) || l.includes('<anonymous>:')) continue;
      const m = /([^/\s(]+\.js)(?:\?[^:]*)?:(\d+):\d+/.exec(l);
      if (m) return m[1] + ':' + m[2];
    }
    return '?';
  };
  const bump = (map, k) => { if (k) map.set(k, (map.get(k) || 0) + 1); };

  window.setTimeout = function (fn, ms, ...args) {
    if (typeof fn !== 'function') return native.setTimeout(fn, ms, ...args);
    const site = where();
    P.timeout.set++;
    const id = native.setTimeout(function () { P.liveTimeouts.delete(id); P.timeout.fired++; bump(P.sites.timeout, site); return fn.apply(this, args); }, ms);
    P.liveTimeouts.set(id, site);
    return id;
  };
  window.clearTimeout = function (id) { if (P.liveTimeouts.delete(id)) P.timeout.cleared++; return native.clearTimeout(id); };
  window.setInterval = function (fn, ms, ...args) {
    if (typeof fn !== 'function') return native.setInterval(fn, ms, ...args);
    const site = where() + ' @' + ms + 'ms';
    P.interval.set++;
    const id = native.setInterval(function () { P.interval.fired++; bump(P.sites.interval, site); return fn.apply(this, args); }, ms);
    P.liveIntervals.set(id, site);
    return id;
  };
  window.clearInterval = function (id) { if (P.liveIntervals.delete(id)) P.interval.cleared++; return native.clearInterval(id); };
  window.requestAnimationFrame = function (fn) {
    const site = where();
    P.raf.requested++;
    const id = native.raf(function (t) { P.liveRafs.delete(id); P.raf.fired++; bump(P.sites.raf, site); return fn.call(this, t); });
    P.liveRafs.add(id);
    return id;
  };
  window.cancelAnimationFrame = function (id) { if (P.liveRafs.delete(id)) P.raf.cancelled++; return native.caf(id); };

  // observers: how often their callbacks run, and what a ResizeObserver still watches. Nothing the page made is kept
  // alive from here (weak references only): what the page drops must be free to go, or this file would be the leak.
  const roRefs = new Set();   // WeakRef of every ResizeObserver still alive
  const roGone = new FinalizationRegistry(ref => roRefs.delete(ref));
  window.MutationObserver = class extends native.MO {
    constructor(cb) { const site = where(); super(function (records, o) { P.mo.callbacks++; P.mo.records += records.length; bump(P.sites.mo, site); return cb.call(this, records, o); }); P.mo.made++; }
  };
  if (native.RO) window.ResizeObserver = class extends native.RO {
    constructor(cb) {
      const site = where();
      super(function (entries, o) { P.ro.callbacks++; P.ro.entries += entries.length; bump(P.sites.ro, site); return cb.call(this, entries, o); });
      P.ro.made++; this.__targets = new Map();   // WeakRef → true, one per element observed
      this.__seen = new WeakMap();               // element → its WeakRef
      const ref = new WeakRef(this); roRefs.add(ref); roGone.register(this, ref);
    }
    observe(el, o) { if (el && typeof el === 'object' && !this.__seen.has(el)) { const ref = new WeakRef(el); this.__seen.set(el, ref); this.__targets.set(ref, true); } return super.observe(el, o); }
    unobserve(el) { const ref = el && this.__seen.get(el); if (ref) { this.__targets.delete(ref); this.__seen.delete(el); } return super.unobserve(el); }
    disconnect() { this.__targets.clear(); this.__seen = new WeakMap(); return super.disconnect(); }
  };

  window.addEventListener('error', e => P.errors.push(String(e.message) + ' @' + String(e.filename).split('/').pop() + ':' + e.lineno));
  window.addEventListener('unhandledrejection', e => P.errors.push('unhandled: ' + String(e.reason && e.reason.stack || e.reason).slice(0, 300)));

  // long tasks and slow frames, with the script that took the time (Chromium 123+)
  P.long = [];
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) P.long.push({ at: Math.round(e.startTime), ms: Math.round(e.duration), blocking: Math.round(e.blockingDuration || 0),
        scripts: (e.scripts || []).map(s => ({ ms: Math.round(s.duration), src: String(s.sourceURL || '').split('/').pop().split('?')[0] + ':' + (s.sourceFunctionName || s.invoker || ''), layout: Math.round(s.forcedStyleAndLayoutDuration || 0) })) });
    }).observe({ type: 'long-animation-frame', buffered: true });
  } catch (e) { }

  // frame pacing: the time between frames while a recording runs (its own rAF loop, not counted above)
  let rec = null;
  P.frames = {
    start() { const r = rec = { t: [], id: 0 }; const step = t => { if (rec !== r) return; r.t.push(t); r.id = native.raf(step); }; r.id = native.raf(step); },
    stop() { const r = rec; rec = null; if (!r) return []; native.caf(r.id); const d = []; for (let i = 1; i < r.t.length; i++) d.push(+(r.t[i] - r.t[i - 1]).toFixed(2)); return d; },
  };

  const top = (map, n = 12) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  P.snapshot = () => {
    let roWatched = 0, roDetached = 0;
    for (const oref of roRefs) {
      const o = oref.deref(); if (!o) continue;
      for (const ref of [...o.__targets.keys()]) { const el = ref.deref(); if (!el) { o.__targets.delete(ref); continue; } roWatched++; if (!el.isConnected) roDetached++; }
    }
    const anims = document.getAnimations ? document.getAnimations() : [];
    let running = 0, infinite = 0; const loops = new Map();
    for (const a of anims) {
      if (a.playState !== 'running') continue;
      running++;
      let inf = false; try { inf = a.effect && a.effect.getTiming().iterations === Infinity; } catch (e) { }
      if (!inf) continue;
      infinite++;
      const el = a.effect.target, name = a.animationName || a.id || 'anim';
      bump(loops, (el ? (el.id ? '#' + el.id : '.' + String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className).trim().split(/\s+/).slice(0, 2).join('.')) : '?') + (a.effect.pseudoElement || '') + ' ' + name);
    }
    return {
      timeout: { ...P.timeout, live: P.liveTimeouts.size }, interval: { ...P.interval, live: P.liveIntervals.size }, raf: { ...P.raf, live: P.liveRafs.size },
      mo: { ...P.mo }, ro: { ...P.ro, watched: roWatched, detached: roDetached },
      animations: { total: anims.length, running, infinite },
      dom: document.getElementsByTagName('*').length,
      errors: P.errors.slice(),
      detail: {
        intervals: [...P.liveIntervals.values()], timeoutSites: top(P.sites.timeout), intervalSites: top(P.sites.interval), rafSites: top(P.sites.raf),
        moSites: top(P.sites.mo), roSites: top(P.sites.ro), loops: top(loops, 20),
      },
    };
  };
  P.resetSites = () => { for (const m of Object.values(P.sites)) m.clear(); P.long.length = 0; };
})();

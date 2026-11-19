'use strict';
// Opens MIKU's real page (windows/wwwroot or mac/app/wwwroot, unchanged) in Chromium with a stand-in host, and reads
// what it costs: CPU by kind (script, style, layout), memory after a collection, DOM nodes, listeners, timers,
// observers, animations, frame pacing.
const fs = require('node:fs');
const path = require('node:path');
const { cover } = require('./png.cjs');
const { makeLibrary } = require('./library.cjs');
const { FakeHost } = require('./fake-host.cjs');
const { record, summarize } = require('./trace.cjs');

// the repository whose page is opened (MIKU_TEST_ROOT: another checkout, to compare two versions with the same tests)
const ROOT = process.env.MIKU_TEST_ROOT ? path.resolve(process.env.MIKU_TEST_ROOT) : path.resolve(__dirname, '../../../..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function playwright() {
  for (const name of ['playwright', 'playwright-core']) { try { return require(name); } catch (e) { } }
  throw new Error('Playwright is not installed: run "npm install" in tests/performance/browser (see README.md).');
}

/** Chromium for the test: MIKU_TEST_CHANNEL=msedge uses the installed Edge (the engine WebView2 runs on). */
async function launchBrowser(opts = {}) {
  const { chromium } = playwright();
  const channel = opts.channel || process.env.MIKU_TEST_CHANNEL || undefined;
  return chromium.launch({
    headless: opts.headless !== false && process.env.MIKU_TEST_HEADED !== '1', channel,
    args: ['--js-flags=--expose-gc', '--enable-precise-memory-info', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows', '--autoplay-policy=no-user-gesture-required', ...(opts.args || [])],
  });
}

/**
 * One MIKU window. opts: platform 'windows' | 'mac', albums, trackDur, lyrics, signal, ui (ui prefs: theme …),
 * settings, viewport, dpr, extensions [{ id, dir }] (a module's folder holding web/manifest.json), rpc (extra host RPCs).
 */
async function openApp(browser, opts = {}) {
  const platform = opts.platform || 'windows';
  const wwwroot = path.join(ROOT, platform === 'mac' ? 'mac/app/wwwroot' : 'windows/wwwroot');
  const lib = opts.library || makeLibrary({ albums: opts.albums || 600, trackDur: opts.trackDur || 0, seed: opts.seed || 7 });
  const context = await browser.newContext({ viewport: opts.viewport || { width: 1440, height: 900 }, deviceScaleFactor: opts.dpr || 1, locale: 'zh-TW' });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const browserCdp = await browser.newBrowserCDPSession();
  /** CPU seconds used so far by every Chromium process (renderer, GPU / compositor, browser). */
  const cpuTotal = async () => { try { const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo'); return processInfo.reduce((n, p) => n + p.cpuTime, 0); } catch (e) { return NaN; } };
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 400)); });
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + String(e.stack || e).slice(0, 400)));

  // extension modules: served as the host does (https://ext.miku/<folder>/web/…)
  const exts = (opts.extensions || []).map(x => {
    const man = JSON.parse(fs.readFileSync(path.join(x.dir, 'web/manifest.json'), 'utf8'));
    const url = rel => `https://ext.miku/${x.id}/web/${rel}?v=1`;
    return { id: x.id, dir: x.dir, scripts: (man.scripts || []).map(url), styles: (man.styles || []).map(url) };
  });

  let delivered = Promise.resolve();
  const post = msg => { delivered = page.evaluate(m => window.__hostDeliver && window.__hostDeliver(m), msg).catch(() => { }); };
  const host = new FakeHost(lib, post, { ...opts, platform, extensions: exts.map(({ id, scripts, styles }) => ({ id, scripts, styles })) });
  await page.exposeBinding('__hostSend', (_src, raw) => { host.onMessage(raw); });

  const serve = (dir, patch) => async route => {
    const u = new URL(route.request().url());
    let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.join(dir, rel);
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: '' });
    let body = fs.readFileSync(file);
    if (patch) body = patch(rel, body);
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body, headers: { 'cache-control': 'no-store' } });
  };
  // The Mac page asks its own scheme (miku-media://) for the library and covers; a browser outside Electron cannot
  // serve that scheme, so that one address is the https one here. Nothing else in the page is changed.
  const macPatch = (rel, body) => rel === 'core.js' ? Buffer.from(body.toString('utf8').replace("const MEDIA = 'miku-media://media';", "const MEDIA = 'https://media.miku';")) : body;
  await page.route('https://app.miku/**', serve(wwwroot, platform === 'mac' ? macPatch : null));
  await page.route('https://ext.miku/**', async route => {
    const u = new URL(route.request().url());
    const [, id, ...rest] = decodeURIComponent(u.pathname).split('/');
    const x = exts.find(e => e.id === id);
    if (!x) return route.fulfill({ status: 404, body: '' });
    const file = path.join(x.dir, ...rest);
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
  });
  let artRequests = 0;
  await page.route('https://media.miku/**', async route => {
    const u = new URL(route.request().url());
    if (u.pathname === '/library.json') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(lib.json) });
    const m = /^\/art\/([atr])\/(.+)$/.exec(decodeURIComponent(u.pathname));
    if (m) {
      artRequests++;
      const want = +u.searchParams.get('s') || 256;
      const size = [64, 128, 256, 512, 1024].find(s => s >= want) || 1024;
      let seed = 0; for (const ch of m[2]) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
      if (opts.artDelay) await sleep(opts.artDelay);
      return route.fulfill({ status: 200, contentType: 'image/png', body: cover(seed % 48, size), headers: { 'cache-control': 'max-age=86400' } });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await page.route(/^https?:\/\/(?!app\.miku|media\.miku|ext\.miku)/, route => route.abort());

  await page.addInitScript({ path: path.join(__dirname, 'probe.js') });
  await page.addInitScript(mac => {
    const handlers = [];
    window.__hostDeliver = msg => { for (const f of handlers) f(mac ? msg : { data: msg }); };
    if (mac) window.mikuHost = { platform: 'darwin', send: s => window.__hostSend(s), onMessage: f => { handlers.push(f); } };
    else {
      const webview = { postMessage: s => window.__hostSend(s), addEventListener: (type, f) => { if (type === 'message') handlers.push(f); }, removeEventListener() { } };
      try { Object.defineProperty(window, 'chrome', { value: { ...(window.chrome || {}), webview }, configurable: true, writable: true }); } catch (e) { window.chrome.webview = webview; }
    }
  }, platform === 'mac');

  await page.goto('https://app.miku/index.html' + (opts.hash || ''));
  await page.waitForFunction(() => typeof Router !== 'undefined' && Router.cur && Router.cur.name && typeof Lib !== 'undefined' && Lib.loaded, null, { timeout: 30000 });
  await sleep(400);

  const app = {
    page, cdp, host, lib, context, platform, consoleErrors,
    get artRequests() { return artRequests; },
    sleep,
    /** Every message the host has sent has reached the page. */
    flush: () => delivered,
    probe: () => page.evaluate(() => window.__probe.snapshot()),
    async gc() { for (let i = 0; i < 3; i++) { await cdp.send('HeapProfiler.collectGarbage'); await sleep(60); } },
    /** Cumulative counters of the page's main thread (seconds / counts), and its memory. */
    async metrics() {
      const { metrics } = await cdp.send('Performance.getMetrics');
      const m = Object.fromEntries(metrics.map(x => [x.name, x.value]));
      return { at: m.Timestamp, task: m.TaskDuration, script: m.ScriptDuration, layout: m.LayoutDuration, style: m.RecalcStyleDuration, layouts: m.LayoutCount, styles: m.RecalcStyleCount,
        heap: m.JSHeapUsedSize, nodes: m.Nodes, listeners: m.JSEventListeners, documents: m.Documents };
    },
    /** Memory and object counts after a full collection: what is really still held. */
    async held() {
      await app.gc();
      const m = await app.metrics(), p = await app.probe();
      return { heapMB: +(m.heap / 1048576).toFixed(2), nodes: m.nodes, listeners: m.listeners, dom: p.dom, intervals: p.interval.live, timeouts: p.timeout.live,
        roWatched: p.ro.watched, roDetached: p.ro.detached, animations: p.animations.total, infiniteRunning: p.animations.infinite };
    },
    /**
     * What the page does over `ms` (while `during` runs, if given): per second of wall time. cpuPct is the main
     * thread's busy share; the counts say how often it was woken.
     */
    async measure(ms, during) {
      await app.flush();
      await page.evaluate(() => window.__probe.resetSites());
      const c0 = await cpuTotal(), m0 = await app.metrics(), p0 = await app.probe();
      const t0 = Date.now();
      if (during) await during();
      const left = ms - (Date.now() - t0);
      if (left > 0) await sleep(left);
      const m1 = await app.metrics(), p1 = await app.probe(), c1 = await cpuTotal();
      const sec = m1.at - m0.at, per = (a, b) => +((b - a) / sec).toFixed(2);
      return {
        seconds: +sec.toFixed(2),
        allCpuPct: +((c1 - c0) / sec * 100).toFixed(2),
        cpuPct: +((m1.task - m0.task) / sec * 100).toFixed(2), scriptPct: +((m1.script - m0.script) / sec * 100).toFixed(2),
        stylePct: +((m1.style - m0.style) / sec * 100).toFixed(2), layoutPct: +((m1.layout - m0.layout) / sec * 100).toFixed(2),
        stylesPerSec: per(m0.styles, m1.styles), layoutsPerSec: per(m0.layouts, m1.layouts),
        timeoutsPerSec: per(p0.timeout.fired, p1.timeout.fired), intervalsPerSec: per(p0.interval.fired, p1.interval.fired), rafPerSec: per(p0.raf.fired, p1.raf.fired),
        moPerSec: per(p0.mo.callbacks, p1.mo.callbacks), roPerSec: per(p0.ro.callbacks, p1.ro.callbacks),
        infiniteRunning: p1.animations.infinite, detail: p1.detail, errors: p1.errors,
      };
    },
    /** Frame pacing while `action` runs and for `settle` ms after it: the gaps between frames, in ms. */
    async frames(action, settle = 700) {
      await page.evaluate(() => window.__probe.frames.start());
      await action();
      await sleep(settle);
      const d = await page.evaluate(() => window.__probe.frames.stop());
      const sorted = d.slice().sort((a, b) => a - b), q = p => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
      const base = q(0.5) || 16.7;
      return { frames: d.length, median: +base.toFixed(1), p95: +q(0.95).toFixed(1), max: +(sorted[sorted.length - 1] || 0).toFixed(1),
        dropped: d.reduce((n, x) => n + Math.max(0, Math.round(x / base) - 1), 0), slow: d.filter(x => x > base * 1.5).length };
    },
    long: () => page.evaluate(() => window.__probe.long.splice(0)),
    /** Go to a route and wait until it is drawn. */
    async go(hash, settle = 350) { await page.evaluate(h => { go(h); }, hash); await sleep(settle); await app.flush(); },
    /** Start playing the queue (as a double click on a track would). */
    async play(index = 0) { host.jump(index); await sleep(120); await app.flush(); },
    async pause() { if (host.playing) host.pause(true); await sleep(80); await app.flush(); },
    /** Open / close the now-playing view. */
    async nowPlaying(on = true) { await page.evaluate(v => { v ? NowPlaying.show() : NowPlaying.hide(); }, on); await sleep(700); },
    /** The window minimized: the host stops posting and the page reports hidden (as WebView2 / Electron do). */
    async setVisible(visible) {
      host.visible = visible;
      await page.evaluate(v => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => !v });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v ? 'visible' : 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      }, visible);
      await sleep(150);
    },
    /** Mouse-wheel notches over an element (100 px each, like a Windows wheel), `gap` ms apart. */
    async wheel(selector, notches, gap = 50, dir = 1) {
      const box = await page.locator(selector).first().boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 300));
      for (let i = 0; i < notches; i++) { await page.mouse.wheel(0, 100 * dir); await sleep(gap); }
    },
    /** A real click on one of a rail's ‹ › buttons (dir -1 / 1); returns false when that button is disabled. */
    async railClick(rail, dir) {
      const b = page.locator('.rail-nav').nth(rail).locator('.rail-btn').nth(dir > 0 ? 1 : 0);
      if (await b.isDisabled()) return false;
      const box = await b.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down(); await page.mouse.up();
      return true;
    },
    railLeft: rail => page.evaluate(i => document.querySelectorAll('.rail')[i].scrollLeft, rail),
    /** The compositor's layers right now: how many, and which elements most of them belong to. */
    async layers() {
      let layers = null;
      const seen = e => { if (e.layers) layers = e.layers; };
      cdp.on('LayerTree.layerTreeDidChange', seen);
      await cdp.send('DOM.enable'); await cdp.send('LayerTree.enable');
      for (let i = 0; i < 40 && !layers; i++) await sleep(50);
      await sleep(400);
      const by = new Map();
      for (const l of layers || []) {
        let k = '(none)';
        if (l.backendNodeId) {
          try {
            const { node: n } = await cdp.send('DOM.describeNode', { backendNodeId: l.backendNodeId }), at = n.attributes || [];
            k = n.nodeName.toLowerCase() + (at.includes('id') ? '#' + at[at.indexOf('id') + 1] : at.includes('class') ? '.' + String(at[at.indexOf('class') + 1]).split(' ')[0] : '');
          } catch (e) { }
        }
        by.set(k, (by.get(k) || 0) + 1);
      }
      await cdp.send('LayerTree.disable'); cdp.off('LayerTree.layerTreeDidChange', seen);
      return { count: (layers || []).length, top: [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => k + ' ×' + n).join(', ') };
    },
    /** A Chromium trace of `action` (+ `settle` ms), summarized: main-thread time by kind, raster, frames. */
    async trace(action, settle = 600) { const r = await record(browser, page, action, settle); return summarize(r.trace, r.t0, r.t1); },
    async close() { host.close(); await context.close(); },
  };
  return app;
}

module.exports = { ROOT, launchBrowser, openApp, sleep, makeLibrary };

'use strict';
// What MIKU's page is measured doing. Each scenario opens a fresh window (lib/harness.cjs), does one thing a listener
// does, and returns plain numbers. resource.test.cjs holds them to budgets; report.cjs prints them; soak.cjs runs the
// long ones for as long as it is asked to.
const path = require('node:path');
const fs = require('node:fs');
const { ROOT, openApp, sleep } = require('./lib/harness.cjs');

const pick = (m, keys) => Object.fromEntries(keys.map(k => [k, m[k]]));
const STEADY = ['allCpuPct', 'cpuPct', 'scriptPct', 'stylePct', 'layoutPct', 'stylesPerSec', 'layoutsPerSec', 'timeoutsPerSec', 'intervalsPerSec', 'rafPerSec', 'moPerSec', 'roPerSec'];
const steady = async (app, ms) => { const m = await app.measure(ms); return { ...pick(m, STEADY), sites: sites(m.detail), errors: m.errors }; };
const sites = d => ({ timeouts: d.timeoutSites.slice(0, 4), intervals: d.intervalSites.slice(0, 4), raf: d.rafSites.slice(0, 4), mo: d.moSites.slice(0, 4), ro: d.roSites.slice(0, 3), loops: d.loops.slice(0, 6) });
const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const max = a => a.reduce((m, x) => Math.max(m, x), 0);

/** The extension modules checked out beside the repository (Extensions/<Name> or MIKU_EXT_<NAME> = its folder). */
function extension(id) {
  const name = { moodwave: 'MoodWave', daphne: 'Daphne' }[id];
  for (const dir of [process.env['MIKU_EXT_' + id.toUpperCase()], path.join(ROOT, 'Extensions', name)]) {
    if (dir && fs.existsSync(path.join(dir, 'web/manifest.json'))) return { id, dir };
  }
  return null;
}

/* ── steady states: what the page costs per second while nothing is being done to it ──
   Read after the start-up work is over (covers arriving, the signal card's warm-up 3 s after load, the bar's entrance). */
const SETTLE = 6000;
const steadyScenario = (name, opts, prepare, ms = 6000) => ({
  name, kind: 'steady', opts,
  async run(app) { await prepare(app); await sleep(SETTLE); return steady(app, ms); },
});
const playingHome = async app => { await app.play(); };
const nowPlaying = async app => { await app.play(); await app.nowPlaying(true); };

const scenarios = [
  steadyScenario('idle: home, nothing playing', {}, async () => { }),
  steadyScenario('paused: home', {}, async app => { await app.play(); await sleep(400); await app.pause(); }),
  ...['cd', 'hires', 'dsd', 'lossy', 'dsp', 'upsample', 'shared'].map(signal => steadyScenario(`playing: home (${signal})`, { signal }, playingHome)),
  steadyScenario('playing: albums grid', { signal: 'hires' }, async app => { await app.play(); await app.go('#/albums'); }),
  steadyScenario('playing: tracks list', { signal: 'hires' }, async app => { await app.play(); await app.go('#/tracks'); }),
  steadyScenario('playing: now playing, line lyrics', { signal: 'hires', lyrics: 'line' }, nowPlaying),
  steadyScenario('playing: now playing, word lyrics', { signal: 'hires', lyrics: 'word' }, nowPlaying),
  steadyScenario('playing: now playing, no lyrics', { signal: 'hires', lyrics: 'none' }, nowPlaying),
  steadyScenario('paused: now playing, line lyrics', { signal: 'hires', lyrics: 'line' }, async app => { await nowPlaying(app); await app.pause(); }),
  steadyScenario('playing: minimized', { signal: 'hires' }, async app => { await app.play(); await app.setVisible(false); }),
  steadyScenario('playing: home, glass theme', { signal: 'hires', ui: { theme: 'glass' } }, playingHome),
  steadyScenario('playing: now playing, glass theme', { signal: 'hires', ui: { theme: 'glass' }, lyrics: 'line' }, nowPlaying),
  steadyScenario('playing: home, vinyl theme', { signal: 'hires', ui: { theme: 'vinyl' } }, playingHome),
  steadyScenario('playing: now playing, vinyl theme', { signal: 'hires', ui: { theme: 'vinyl' }, lyrics: 'line' }, nowPlaying),
  steadyScenario('playing: home, lightweight page', { signal: 'hires', ui: { lightweight: '1' } }, playingHome),
  steadyScenario('mac, playing: home', { platform: 'mac', signal: 'hires' }, playingHome),
  steadyScenario('mac, playing: now playing, line lyrics', { platform: 'mac', signal: 'hires', lyrics: 'line' }, nowPlaying),
  { ...steadyScenario('playing: home, MoodWave module', { signal: 'hires' }, playingHome), needs: 'moodwave' },

  /* ── the home rails' ‹ › buttons: every click must cost the same, and land on whole cards ── */
  {
    name: 'click: home rail ‹ ›', kind: 'rail', opts: { signal: 'hires' },
    async run(app) {
      await app.play(); await sleep(4000);            // past the load-time work (covers, the signal card's warm-up)
      const clicks = [];
      for (const dir of [1, 1, 1, 1, -1, -1, -1, -1, 1, -1]) {
        const before = await app.railLeft(0);
        let ok;
        const t = await app.trace(async () => { ok = await app.railClick(0, dir); }, 1100);
        if (!ok) continue;
        clicks.push({ dir, moved: Math.round(await app.railLeft(0) - before), busyMs: t.mainBusyMs, longestTaskMs: t.longestTaskMs, styles: t.counts.style, layouts: t.counts.layout, scriptMs: t.ms.script, styleMs: t.ms.style, layoutMs: t.ms.layout, paintMs: t.ms.paint, commits: t.layerTreeCommits, dropped: t.frames.dropped });
      }
      // two quick clicks travel two pages (the second one must not be measured from where the first glide happened to be)
      await app.page.evaluate(() => { document.querySelectorAll('.rail')[1].scrollLeft = 0; }); await sleep(300);
      await app.railClick(1, 1); await sleep(1300);
      const one = await app.railLeft(1);
      await app.page.evaluate(() => { document.querySelectorAll('.rail')[1].scrollLeft = 0; }); await sleep(300);
      await app.railClick(1, 1); await sleep(90); await app.railClick(1, 1); await sleep(1600);
      const two = await app.railLeft(1);
      // each stop leaves a card flush with the rail's left edge (36 px padding)
      const offsets = [];
      await app.page.evaluate(() => { document.querySelectorAll('.rail')[2].scrollLeft = 0; }); await sleep(200);
      for (let i = 0; i < 3; i++) {
        if (!await app.railClick(2, 1)) break;
        await sleep(1300);
        offsets.push(await app.page.evaluate(() => { const r = document.querySelectorAll('.rail')[2], x = r.getBoundingClientRect().left + 36; return Math.min(...[...r.children].map(c => Math.abs(c.getBoundingClientRect().left - x))); }));
      }
      const col = k => clicks.map(c => c[k]);
      return { clicks, styles: { median: median(col('styles')), max: max(col('styles')) }, layouts: { median: median(col('layouts')), max: max(col('layouts')) },
        busyMs: { median: median(col('busyMs')), max: max(col('busyMs')) }, longestTaskMs: max(col('longestTaskMs')), dropped: max(col('dropped')),
        oneClick: Math.round(one), twoQuickClicks: Math.round(two), cardOffsets: offsets.map(o => +o.toFixed(1)) };
    },
  },

  /* ── wheel scrolling through the album grid ── */
  {
    name: 'scroll: albums grid, mouse wheel', kind: 'scroll', opts: { signal: 'hires', albums: 1200 },
    async run(app) {
      await app.play(); await app.go('#/albums'); await sleep(2500);
      const t = await app.trace(() => app.wheel('#content', 40, 50), 1200);
      const m = await app.measure(3200, () => app.wheel('#content', 40, 50));
      const fr = await app.frames(() => app.wheel('#content', 30, 50, -1), 900);
      return { ...pick(m, STEADY), busyMs: t.mainBusyMs, longestTaskMs: t.longestTaskMs, styles: t.counts.style, layouts: t.counts.layout, ms: t.ms, frames: fr, sites: sites(m.detail), errors: m.errors };
    },
  },

  /* ── next track, several times: each change costs the same, nothing is left behind ── */
  {
    name: 'change: next track ×12 (now playing open)', kind: 'change', opts: { signal: 'hires', lyrics: 'line' },
    async run(app) {
      await app.play(); await app.nowPlaying(true); await sleep(1500);
      // What is held is read with the same track on screen before and after (each track has its own number of lyric
      // lines), and after a few changes have filled what is meant to be kept (covers, the lyrics cache).
      const next = async () => { await app.page.evaluate(() => { Host.call('next'); }); await sleep(900); await app.flush(); };
      const first = async () => { await app.play(0); await sleep(1500); return app.held(); };
      for (let i = 0; i < 3; i++) await next();
      const before = await first();
      const costs = [];
      for (let i = 0; i < 12; i++) {
        const m0 = await app.metrics();
        await next();
        const m1 = await app.metrics();
        costs.push(+((m1.task - m0.task) * 1000).toFixed(1));
      }
      const after = await first();
      return { taskMs: { first: costs[0], median: median(costs), max: max(costs) }, before, after, grew: grew(before, after) };
    },
  },
];

const HELD = ['heapMB', 'nodes', 'listeners', 'dom', 'intervals', 'timeouts', 'roWatched', 'roDetached', 'animations'];
const grew = (a, b) => Object.fromEntries(HELD.map(k => [k, +(b[k] - a[k]).toFixed(2)]));

/* ── long runs: the same things done over and over; what is held must level off ── */
const ROUTES = ['#/albums', '#/artists', '#/tracks', '#/favorites', '#/folders', '#/settings/audio', '#/settings/library', '#/settings/look', '#/settings/keys', '#/settings/other', '#/home'];

/** One round of use: every page, an album and an artist opened, the queue and the signal card, now playing, a few tracks. */
async function useRound(app, n) {
  const { page } = app;
  for (const r of ROUTES) await app.go(r, 140);
  const al = app.lib.albums[(n * 7) % app.lib.albums.length];
  await app.go('#/album/' + al[0], 200);
  await app.go('#/artist/' + encodeURIComponent(al[2]), 200);
  await page.evaluate(() => history.back()); await sleep(200);
  await page.evaluate(() => history.back()); await sleep(200);
  await app.go('#/search/' + encodeURIComponent('Blue'), 200);
  await page.evaluate(() => { Drawer.toggle('queue'); }); await sleep(260);
  await page.evaluate(() => { Drawer.toggle('queue'); }); await sleep(200);
  await page.evaluate(() => { document.getElementById('b-sig').click(); }); await sleep(260);
  await page.evaluate(() => { document.getElementById('b-sig').click(); }); await sleep(200);
  await app.nowPlaying(true);
  for (let i = 0; i < 3; i++) { await page.evaluate(() => { Host.call('next'); }); await sleep(260); }
  await app.nowPlaying(false);
  await app.go('#/home', 200);
  await app.railClick(0, 1); await sleep(250);
  await app.wheel('#content', 6, 30); await app.wheel('#content', 6, 30, -1);
}

/**
 * Rounds of use, read after a full collection every `every` rounds (on the album grid, with the same track playing). Returns the samples and how much each count
 * moved per round over the second half (the first rounds fill caches that are meant to be kept).
 */
async function soak(app, { rounds = 40, every = 5, minutes = 0, log = null } = {}) {
  await app.play(); await sleep(800);
  const samples = [];
  const until = minutes ? Date.now() + minutes * 60000 : 0;
  for (let n = 1; until ? Date.now() < until : n <= rounds; n++) {
    await useRound(app, n);
    if (n % every === 0) {
      // read on the same page every time, once the covers it shows have arrived: a cover still loading is a placeholder
      // and an observer more, and a round ends on home, whose rails are shuffled at every visit. Read as they came, the
      // counts moved by ±50 nodes between samples, which the growth per round was judged against.
      app.host.jump(0, 30); await sleep(400);           // the same track each time (its lyrics, cover and queue row)
      await app.go('#/albums', 300);
      await app.page.waitForFunction(() => [...document.querySelectorAll('#view img')].every(i => {
        const r = i.getBoundingClientRect();
        return i.complete || r.bottom < 0 || r.top > innerHeight;
      }), null, { timeout: 4000 }).catch(() => {});
      await sleep(1300);                                // past the delayed work a round leaves behind (and the fade-ins)
      const h = { round: n, ...(await app.held()), hostListeners: await app.page.evaluate(() => typeof Host.listenerCount === 'function' ? Host.listenerCount() : -1) };
      samples.push(h);
      if (log) log(h);
    }
  }
  const idle = await app.measure(5000);
  const half = samples.slice(Math.floor(samples.length / 2));
  // least squares over every sample of the second half, not its first and last only: one sample a little high or low
  // at either end no longer reads as growth (or hides it)
  const slope = k => {
    if (half.length < 2) return 0;
    const n = half.length, mx = half.reduce((a, h) => a + h.round, 0) / n, my = half.reduce((a, h) => a + h[k], 0) / n;
    const sxy = half.reduce((a, h) => a + (h.round - mx) * (h[k] - my), 0), sxx = half.reduce((a, h) => a + (h.round - mx) ** 2, 0);
    return +(sxy / sxx).toFixed(3);
  };
  return { rounds: samples.length ? samples[samples.length - 1].round : 0, first: samples[0], last: samples[samples.length - 1],
    perRound: Object.fromEntries([...HELD, 'hostListeners'].map(k => [k, slope(k)])), idleAfter: pick(idle, STEADY), samples, errors: idle.errors };
}

scenarios.push({
  name: 'long run: 30 rounds of use', kind: 'soak', opts: { signal: 'hires', lyrics: 'line', albums: 400 }, slow: true,
  run: app => soak(app, { rounds: 30, every: 5 }),
});

/** Opens a window for one scenario, runs it, closes it. `null` when the scenario needs a module that is not there. */
async function runScenario(browser, sc, extra = {}) {
  const opts = { ...sc.opts, ...extra };
  if (sc.needs) { const x = extension(sc.needs); if (!x) return null; opts.extensions = [x]; }
  const app = await openApp(browser, opts);
  try {
    const result = await sc.run(app);
    return { ...result, consoleErrors: app.consoleErrors.slice(0, 5), unknownRpc: [...app.host.unknown.keys()] };
  } finally { await app.close(); }
}

module.exports = { scenarios, runScenario, soak, useRound, extension, STEADY, HELD };

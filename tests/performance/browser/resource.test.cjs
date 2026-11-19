'use strict';
// What MIKU's page costs, held to budgets (budgets.cjs). The real page (windows/wwwroot and mac/app/wwwroot, unchanged)
// runs in Chromium against a stand-in host; every test opens a fresh window, does what a listener does, and reads
// what that cost: style passes, layouts, timers, frames, observers, compositor layers, and what is still held after
// a full garbage collection.
//
//   node --test tests/performance/browser/resource.test.cjs          (about 15 minutes)
//   MIKU_PERF_ONLY="rail|scroll" node --test …                        only the tests whose name matches
//
// See README.md for what each number means and what it was before.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { launchBrowser, openApp, sleep } = require('./lib/harness.cjs');
const { scenarios, runScenario, soak } = require('./scenarios.cjs');
const B = require('./budgets.cjs');

const ONLY = process.env.MIKU_PERF_ONLY ? new RegExp(process.env.MIKU_PERF_ONLY, 'i') : null;
const check = (name, fn) => test(name, { skip: ONLY && !ONLY.test(name) ? 'not selected' : false, timeout: 20 * 60000 }, fn);
const scenario = name => scenarios.find(s => s.name === name);

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { if (browser) await browser.close(); });

/** The page itself must have nothing to complain about: no exception, no console error. */
function quiet(r) {
  assert.deepEqual(r.errors || [], [], 'the page threw');
  assert.deepEqual(r.consoleErrors || [], [], 'the page logged errors');
}

/**
 * Runs a scenario and returns what `problems(result)` finds. A scenario that is over a budget is run once more, and
 * only the second result counts: one measurement can catch a garbage collection or a cover that arrived late, two in a
 * row cannot. (The retry is reported, so a budget that needs it often is seen.)
 */
async function held(t, sc, problems) {
  let r = await runScenario(browser, sc);
  if (r === null) return null;
  let found = problems(r);
  if (found.length) {
    t.diagnostic('over budget once, measured again: ' + found.join('; '));
    r = await runScenario(browser, sc);
    found = problems(r);
  }
  quiet(r);
  assert.deepEqual(found, [], sc.name);
  return r;
}

/* ── at rest ── */
for (const sc of scenarios.filter(s => s.kind === 'steady')) {
  check('at rest, ' + sc.name, async t => {
    const budget = B.STEADY[sc.name];
    assert.ok(budget, 'every steady scenario has a budget in budgets.cjs');
    const r = await held(t, sc, r => {
      const p = B.over(r, budget);
      // paused, minimized or idle, no decoration may keep looping: each one is frames drawn for nobody
      if (/^(idle|paused)|minimized/.test(sc.name) && r.sites.loops.length) p.push('still looping: ' + r.sites.loops.map(l => l[0]).join(', '));
      return p;
    });
    if (r === null) return t.skip('module not checked out (MIKU_EXT_' + sc.needs.toUpperCase() + ')');
    t.diagnostic(`main thread ${r.cpuPct} %, per second: style ${r.stylesPerSec}, layout ${r.layoutsPerSec}, timeouts ${r.timeoutsPerSec}, intervals ${r.intervalsPerSec}, rAF ${r.rafPerSec}, MO ${r.moPerSec}`);
  });
}

/* ── the home rails' ‹ › ── */
check('home rail ‹ ›: every click travels one page of whole cards, and costs the same', async t => {
  const r = await held(t, scenario('click: home rail ‹ ›'), r => {
    const p = [], moved = r.clicks.map(c => c.moved), page = Math.max(...moved.map(Math.abs));
    if (r.clicks.length !== 10) p.push(`only ${r.clicks.length} of 10 clicks were taken`);
    // forward to the end, back to the start, one more page and back: where it began, by the same stops both ways
    if (Math.abs(moved.reduce((a, b) => a + b, 0)) > 1) p.push('forward and back did not return to the start: ' + moved.join(', '));
    if (new Set(moved.map(Math.abs)).size > 2) p.push('clicks travel different distances: ' + moved.join(', '));
    if (moved[0] !== page || r.oneClick !== page) p.push(`a click from the start travels ${moved[0]} / ${r.oneClick} px, a page is ${page} px`);
    if (r.twoQuickClicks !== 2 * r.oneClick) p.push(`two quick clicks travel ${r.twoQuickClicks} px, two pages are ${2 * r.oneClick} px`);
    if (r.cardOffsets.length !== 3 || r.cardOffsets.some(o => o > B.RAIL.flushPx)) p.push('a click stopped between cards: off by ' + r.cardOffsets.join(', ') + ' px');
    if (r.styles.max > B.RAIL.styles) p.push(`a click cost ${r.styles.max} style passes (budget ${B.RAIL.styles})`);
    if (r.layouts.max > B.RAIL.layouts) p.push(`a click cost ${r.layouts.max} layouts (budget ${B.RAIL.layouts})`);
    if (r.styles.max > r.styles.median * B.RAIL.spread) p.push(`clicks cost differently: ${r.clicks.map(c => c.styles).join(', ')} style passes`);
    if (r.longestTaskMs > B.RAIL.longestTaskMs) p.push(`the main thread was held for ${r.longestTaskMs} ms (budget ${B.RAIL.longestTaskMs})`);
    return p;
  });
  t.diagnostic(`per click: ${r.styles.median} style passes (max ${r.styles.max}), ${r.layouts.median} layouts (max ${r.layouts.max}), longest task ${r.longestTaskMs} ms; moved ${r.clicks.map(c => c.moved).join(', ')}`);
});

/* ── wheel scrolling ── */
check('wheel scrolling the album grid: no chain of observers behind every frame', async t => {
  const r = await held(t, scenario('scroll: albums grid, mouse wheel'), r => {
    const { longestTaskMs, ...perSec } = B.SCROLL, p = B.over(r, perSec);
    if (r.longestTaskMs > longestTaskMs) p.push(`the main thread was held for ${r.longestTaskMs} ms (budget ${longestTaskMs})`);
    return p;
  });
  t.diagnostic(`per second: style ${r.stylesPerSec}, layout ${r.layoutsPerSec}, MO ${r.moPerSec}, rAF ${r.rafPerSec}; longest task ${r.longestTaskMs} ms; frames p95 ${r.frames.p95} ms`);
});

/* ── track changes ── */
check('twelve track changes with now playing open leave nothing behind', async t => {
  const r = await held(t, scenario('change: next track ×12 (now playing open)'), r => {
    const { spread, ...counts } = B.CHANGE, p = [];
    for (const [k, limit] of Object.entries(counts)) if (r.grew[k] > limit) p.push(`${k} grew by ${r.grew[k]} (budget ${limit})`);
    if (r.taskMs.max > r.taskMs.median * spread + 40 * B.CPU) p.push(`one change cost ${r.taskMs.max} ms, the median one ${r.taskMs.median} ms`);
    return p;
  });
  t.diagnostic(`per change: median ${r.taskMs.median} ms, max ${r.taskMs.max} ms; grew ${JSON.stringify(r.grew)}`);
});

/* ── a long run, short enough for a test (soak.cjs runs it for hours) ── */
check('fifteen rounds of use: nothing keeps growing, and the page costs the same afterwards', async t => {
  const app = await openApp(browser, { signal: 'hires', lyrics: 'line', albums: 400 });
  try {
    const r = await soak(app, { rounds: 15, every: 3 });
    r.consoleErrors = app.consoleErrors.slice(0, 5);
    t.diagnostic('per round: ' + JSON.stringify(r.perRound));
    assert.deepEqual(B.checkSoak(r), []);
  } finally { await app.close(); }
});

/* ── settings: the page that took host-event listeners on every visit and never gave them back ── */
for (const platform of ['windows', 'mac']) {
  check(`settings (${platform}): eight visits to every tab hold what two did`, async t => {
    const app = await openApp(browser, { platform, albums: 300, signal: 'hires' });
    try {
      await app.play(); await sleep(1500);
      const visit = async () => { for (const tab of ['audio', 'library', 'look', 'keys', 'other']) await app.go('#/settings/' + tab, 160); await app.go('#/albums', 160); };
      const read = async () => ({ ...(await app.held()), host: await app.page.evaluate(() => typeof Host.listenerCount === 'function' ? Host.listenerCount() : -1) });
      for (let i = 0; i < 2; i++) await visit();
      await sleep(1200);
      const a = await read();
      for (let i = 0; i < 8; i++) await visit();
      await sleep(1200);
      const b = await read();
      t.diagnostic(`host listeners ${a.host} → ${b.host}, nodes ${a.nodes} → ${b.nodes}, listeners ${a.listeners} → ${b.listeners}`);
      assert.equal(b.host, a.host, 'host-event listeners (Host.on) were left behind');
      assert.ok(b.nodes - a.nodes <= 8 * 5, `DOM nodes kept: ${a.nodes} → ${b.nodes}`);
      assert.ok(b.listeners - a.listeners <= 8, `event listeners kept: ${a.listeners} → ${b.listeners}`);
      assert.deepEqual(app.consoleErrors, []);
    } finally { await app.close(); }
  });
}

/* ── the bar's signal badge (effects.js, IdleFx) ── */
check('signal badge: its loops are stepped, follow the badge, and stop wherever it cannot be seen', async () => {
  const app = await openApp(browser, { albums: 300, signal: 'hires', lyrics: 'line' });
  try {
    const { page } = app;
    await app.play(); await sleep(4500);
    const state = () => page.evaluate(() => {
      const loop = a => a.effect && a.effect.target instanceof Element && a.effect.getTiming().iterations === Infinity;
      const all = document.getAnimations().filter(loop), badge = all.filter(a => a.effect.target.closest('#bar .sig'));
      return {
        badge: document.getElementById('b-sig').className, loops: badge.length, running: badge.filter(a => a.playState === 'running').length,
        stepped: IdleFx.steps.size, stale: [...IdleFx.steps.keys()].filter(a => a.currentTime === null || !badge.includes(a)).length, clock: !!IdleFx.stepTimer,
        times: badge.map(a => a.currentTime),
        behind: all.filter(a => a.playState === 'running' && a.effect.target.closest('#bar, #main, #sidebar')).length,
        anywhere: all.filter(a => a.playState === 'running').length,
      };
    });
    const stepping = async (where, wanted = true) => {
      const s = await state();
      assert.equal(s.stale, 0, `${where}: a loop of an earlier badge is still being stepped (${s.badge})`);
      assert.equal(s.running, 0, `${where}: a loop of the badge runs at the display's rate (${s.badge})`);
      if (!wanted) { assert.equal(s.stepped, 0, `${where}: the badge is still being stepped`); assert.equal(s.clock, false, `${where}: the step clock still ticks`); return s; }
      assert.equal(s.stepped, s.loops, `${where}: ${s.loops} loops, ${s.stepped} stepped (${s.badge})`);
      assert.equal(s.clock, s.loops > 0, `${where}: the step clock runs only while there is something to step`);
      if (s.loops) { await sleep(400); const later = (await state()).times; assert.ok(later.some((x, i) => x !== s.times[i]), `${where}: the loops do not advance`); }
      return s;
    };

    // every kind of badge, one after the other: the loops of the one before are gone, the new one's are stepped
    let withLoops = 0;
    for (const kind of ['cd', 'dsd', 'lossy', 'dsp', 'upsample', 'shared', 'hires']) {
      app.host.opts.signal = kind; app.host.soon('state'); await sleep(1500);
      if ((await stepping('badge ' + kind)).loops) withLoops++;
    }
    assert.ok(withLoops >= 5, 'the badges still have their loops (nothing was removed to make this cheap)');

    // now playing, opened all the way, covers the bar and the library
    await app.nowPlaying(true); await sleep(1800);
    let s = await stepping('behind now playing', false);
    assert.equal(s.behind, 0, 'something behind the now-playing page still loops');
    await page.evaluate(() => document.getElementById('bar-peek').click()); await sleep(900);      // the bar called back up
    assert.ok((await stepping('bar called back up')).loops > 0);
    await page.evaluate(() => document.getElementById('bar-peek').click()); await sleep(900);
    await stepping('bar sent away again', false);
    await app.nowPlaying(false); await sleep(1200);
    assert.ok((await stepping('now playing closed')).loops > 0);

    // paused: the badge freezes where it is
    await app.pause(); await sleep(500);
    await stepping('paused', false);
    await app.play(); await sleep(700);
    assert.ok((await stepping('playing again')).loops > 0);

    // the window minimized: nothing loops anywhere
    await app.setVisible(false); await sleep(400);
    s = await stepping('minimized', false);
    assert.equal(s.anywhere, 0, 'a loop keeps running in a window nobody sees');
    await app.setVisible(true); await sleep(500);
    assert.ok((await stepping('window shown again')).loops > 0);
    assert.deepEqual(app.consoleErrors, []);
  } finally { await app.close(); }
});

/* ── Glass's light orbs: three blurred, blended, window-sized layers; drawn at the display's rate they kept a 120 Hz
   Mac's GPU process at about half a core. They are stepped on the badge's clock, and freeze while paused. ── */
check('glass theme: the background orbs are stepped with the badge, never at the display\'s rate, and freeze while paused', async () => {
  const app = await openApp(browser, { albums: 300, signal: 'hires', ui: { theme: 'glass' } });
  try {
    const { page } = app;
    await app.play(); await sleep(3000);
    const orbs = () => page.evaluate(() => {
      const list = document.getAnimations().filter(a => a.effect && a.effect.target instanceof Element && a.effect.target.closest('#theme-bg'));
      return { n: list.length, running: list.filter(a => a.playState === 'running').length, stepped: list.filter(a => IdleFx.steps.has(a)).length, times: list.map(a => a.currentTime) };
    });
    let o = await orbs();
    assert.ok(o.n >= 3, `the orbs are still there and still move (${o.n} loops)`);
    assert.equal(o.running, 0, 'an orb runs at the display\'s rate');
    assert.equal(o.stepped, o.n, 'every orb is stepped');
    await sleep(500);
    assert.ok((await orbs()).times.some((t, i) => t !== o.times[i]), 'the stepped orbs do not move');
    await app.pause(); await sleep(400);
    o = await orbs();
    assert.equal(o.stepped, 0, 'paused: the orbs are still being stepped');
    assert.equal(o.running, 0, 'paused: an orb still runs');
    await app.play(); await sleep(600);
    assert.equal((await orbs()).stepped, o.n, 'playing again: the orbs are stepped again');
    assert.deepEqual(app.consoleErrors, []);
  } finally { await app.close(); }
});

/* ── compositor layers: each one is memory, and is gone through again for every frame the page draws ── */
for (const theme of ['miku', 'glass', 'vinyl']) {
  check(`layers (${theme} theme): album cards at rest are not layers of their own`, async t => {
    const app = await openApp(browser, { albums: 300, signal: 'hires', lyrics: 'line', ui: { theme } });
    try {
      await app.play(); await sleep(3500);                          // past the entrance animations
      const home = await app.layers();
      await app.go('#/albums', 1500);
      const grid = await app.layers();
      await app.nowPlaying(true); await sleep(1200); await app.nowPlaying(false); await sleep(1200);
      const after = await app.layers();
      t.diagnostic(`home ${home.count}, albums grid ${grid.count}, after now playing ${after.count}`);
      assert.ok(home.count <= B.LAYERS.home, `home page: ${home.count} layers (budget ${B.LAYERS.home}): ${home.top}`);
      assert.ok(grid.count <= B.LAYERS.grid, `albums grid: ${grid.count} layers (budget ${B.LAYERS.grid}): ${grid.top}`);
      assert.ok(after.count <= grid.count + 4, `now playing left layers behind: ${grid.count} → ${after.count}: ${after.top}`);
    } finally { await app.close(); }
  });
}

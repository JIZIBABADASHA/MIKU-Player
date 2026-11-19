'use strict';
// What MIKU's page may cost. resource.test.cjs and soak.cjs hold what scenarios.cjs measures to these numbers.
//
// The counts (style passes, layouts, timers, frames, observer callbacks per second or per action; nodes, listeners,
// observers held) do not depend on the machine: a style pass is a style pass, so their ceilings sit close above what
// the page does today and fail as soon as something is added per frame or left behind per visit. CPU shares do depend
// on the machine, so those ceilings are wide (they catch a page that got several times dearer, nothing subtler) and
// can be scaled: MIKU_PERF_CPU_SCALE=2 on a slow or busy machine.
//
// A budget raised here is a decision that the page may cost more: say why in the commit.

const CPU = +process.env.MIKU_PERF_CPU_SCALE || 1;
const NAMES = { stylesPerSec: 'style passes', layoutsPerSec: 'layouts', timeoutsPerSec: 'timeouts fired', intervalsPerSec: 'interval ticks', rafPerSec: 'animation-frame callbacks',
  moPerSec: 'MutationObserver callbacks', roPerSec: 'ResizeObserver callbacks', cpuPct: 'main thread busy' };

/* ── at rest: per second of wall time ──
   Playing, the page draws the progress bar (5 state reports a second from the host, 5 timer ticks between them) and
   steps the bar's signal badge 24 times a second (effects.js, IdleFx): about 32 style passes and 10 layouts a second.
   Nothing else may tick: no per-frame loop, no observer chatter. */
const NOTHING = { stylesPerSec: 1, layoutsPerSec: 1, timeoutsPerSec: 1, intervalsPerSec: 0.5, rafPerSec: 0.5, moPerSec: 1, roPerSec: 0.5, cpuPct: 1.5 };
const PAUSED = { ...NOTHING, stylesPerSec: 2.5, intervalsPerSec: 1.5 };                 // the host still reports once a second
const PLAYING = { stylesPerSec: 40, layoutsPerSec: 12, timeoutsPerSec: 6.5, intervalsPerSec: 25.5, rafPerSec: 1, moPerSec: 2, roPerSec: 0.5, cpuPct: 25 };
const NO_BADGE_LOOPS = { ...PLAYING, stylesPerSec: 12, intervalsPerSec: 0.5, cpuPct: 12 };   // a badge without loops, or loops switched off
// Now playing covers the bar and the library: their loops stop. What is left is the progress bar, the lyrics (a line
// at a time: timers; word by word: animation frames while a word is being sung) and select.js's 1 s check.
const NOW_PLAYING = { stylesPerSec: 14, layoutsPerSec: 12, timeoutsPerSec: 6.5, intervalsPerSec: 2, rafPerSec: 1, moPerSec: 2, roPerSec: 0.5, cpuPct: 12 };

const STEADY = {
  'idle: home, nothing playing': NOTHING,
  'paused: home': PAUSED,
  'playing: home (cd)': PLAYING,
  'playing: home (hires)': PLAYING,
  'playing: home (dsd)': PLAYING,
  'playing: home (lossy)': PLAYING,
  'playing: home (dsp)': PLAYING,
  'playing: home (upsample)': PLAYING,
  'playing: home (shared)': NO_BADGE_LOOPS,
  'playing: albums grid': PLAYING,
  'playing: tracks list': PLAYING,
  'playing: now playing, line lyrics': NOW_PLAYING,
  'playing: now playing, word lyrics': { ...NOW_PLAYING, stylesPerSec: 20, rafPerSec: 30 },
  'playing: now playing, no lyrics': NOW_PLAYING,
  'paused: now playing, line lyrics': PAUSED,
  'playing: minimized': NOTHING,                                                       // minimized: as if nothing played
  'playing: home, glass theme': PLAYING,
  // Glass's now-playing panel leaves a 12 px margin where the background orbs still show: they keep their 24 fps step
  // clock (effects.js IdleFx), one interval tick per step. Drawn at the display's rate instead they cost the GPU far more.
  'playing: now playing, glass theme': { ...NOW_PLAYING, intervalsPerSec: 25.5 },
  'playing: home, vinyl theme': { ...PLAYING, stylesPerSec: 60 },                      // + the mini cover's spin (see README)
  'playing: now playing, vinyl theme': NOW_PLAYING,
  'playing: home, lightweight page': NO_BADGE_LOOPS,
  'mac, playing: home': PLAYING,
  'mac, playing: now playing, line lyrics': NOW_PLAYING,
  'playing: home, MoodWave module': PLAYING,
};

/* ── a click on a home rail's ‹ › (traced for 1.1 s: the glide and what follows it) ── */
const RAIL = {
  styles: 120, layouts: 30,        // style passes / layouts per click, the dearest click (was 745 / 569)
  spread: 1.6,                     // the dearest click costs at most this many times the median one
  longestTaskMs: 60 * CPU,         // no single stretch of main-thread work longer than this
  flushPx: 1,                      // after a click a card sits within this of the rail's left edge
};

/* ── wheel scrolling through the album grid (40 notches, 50 ms apart) ──
   One style pass and a layout for a frame that brings in a new row of cards (the grid is virtual: views.js), the
   smoothing's own frame callbacks (smooth.js), an observer callback per row of new covers (ArtSharp). It was 580
   style passes, 394 layouts and 572 MutationObserver callbacks a second. */
const SCROLL = { stylesPerSec: 200, layoutsPerSec: 70, moPerSec: 160, roPerSec: 15, intervalsPerSec: 26, longestTaskMs: 60 * CPU };

/* ── twelve track changes with now playing open: what is held afterwards, compared with before ── */
const CHANGE = { nodes: 40, listeners: 4, dom: 6, intervals: 0, roWatched: 0, animations: 4, spread: 4 };

/* ── long runs: what may be added per round of use over the second half of the run ──
   A round is some thirty actions (scenarios.cjs, useRound). Zero would be the honest number for all of them; the
   margins are for what a collection leaves to the next one. Heap is the loosest: V8 keeps compiled code and inline
   caches it warms up over many rounds. */
const SOAK = { nodes: 3, listeners: 1, hostListeners: 0, dom: 1, intervals: 0, timeouts: 0.5, roWatched: 0.5, roDetached: 0.2, animations: 0.5, heapMB: 0.12 };

/* ── compositor layers ──
   The home page has six rails (each scrolls: a layer or two) and the bar's sliders: about 50 layers, 70 with Glass's
   panels. A layer per album card (a will-change, a 3D transform, a backdrop blur or an animation's fill left on every
   card) is 100 to 300 more: Glass and Vinyl had 365 and 344, the default theme 102. */
const LAYERS = { home: 100, grid: 70 };

/** Every budget of `budget` that `m` is over, in words. Empty when it holds. */
function over(m, budget, scale = {}) {
  const out = [];
  for (const [k, limit] of Object.entries(budget)) {
    const lim = k === 'cpuPct' ? limit * CPU : limit * (scale[k] || 1);
    if (!(m[k] <= lim)) out.push(`${NAMES[k] || k}: ${m[k]}${k === 'cpuPct' ? ' %' : k.endsWith('PerSec') ? ' /s' : ''} (budget ${+lim.toFixed(2)})`);
  }
  return out;
}

/** What a long run (scenarios.cjs, soak) did wrong, in words. Empty when nothing kept growing. */
function checkSoak(r, budget = SOAK) {
  const out = [];
  for (const [k, limit] of Object.entries(budget)) if (!(r.perRound[k] <= limit)) out.push(`${k} grew by ${r.perRound[k]} per round over the second half (budget ${limit}): ${r.samples.map(s => s[k]).join(' → ')}`);
  // at rest after the run the page costs what a fresh page costs
  out.push(...over(r.idleAfter, STEADY['playing: home (hires)']).map(p => 'at rest after the run, ' + p));
  if (r.idleBefore) for (const k of ['stylesPerSec', 'layoutsPerSec', 'timeoutsPerSec', 'intervalsPerSec', 'rafPerSec', 'moPerSec']) {
    if (r.idleAfter[k] > r.idleBefore[k] * 1.25 + 2) out.push(`at rest, ${NAMES[k]} went from ${r.idleBefore[k]} /s before the run to ${r.idleAfter[k]} /s after it`);
  }
  if (r.errors && r.errors.length) out.push('the page reported errors: ' + JSON.stringify(r.errors.slice(0, 3)));
  if (r.consoleErrors && r.consoleErrors.length) out.push('console errors: ' + JSON.stringify(r.consoleErrors.slice(0, 3)));
  return out;
}

module.exports = { STEADY, RAIL, SCROLL, CHANGE, SOAK, LAYERS, CPU, over, checkSoak };

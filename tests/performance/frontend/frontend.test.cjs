'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const root = path.resolve(__dirname, '../../..');

function frontend(platform) {
  const pending = new Map(), observers = [], events = new Map();
  let nextFrame = 0, marks = 0, geometryReads = 0;
  const content = {
    scrollTop: 10, clientHeight: 136,
    getBoundingClientRect: () => ({ top: 0 }),
    addEventListener: (name, fn) => events.set(name, fn),
    removeEventListener: name => events.delete(name),
  };
  function node() {
    return {
      children: [], style: {}, clientWidth: 1000,
      append(child) { this.children.push(child); child.parent = this; },
      remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); },
      getBoundingClientRect() { geometryReads++; return { top: -content.scrollTop }; },
    };
  }
  const ctx = vm.createContext({
    document: { addEventListener() {} }, window: { addEventListener() {}, removeEventListener() {} },
    $: () => content, h: node, App: { settings: { ui: { gridCols: '4' } } },
    requestAnimationFrame(fn) { const id = ++nextFrame; pending.set(id, fn); return id; },
    cancelAnimationFrame(id) { pending.delete(id); },
    ResizeObserver: class { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() {} },
    ArtSharp: { release() {} }, Motion: { quiet: true },
  });
  const source = readFileSync(path.join(root, platform, 'wwwroot/views.js'), 'utf8');
  vm.runInContext(source + '\nglobalThis.api = { searchMatches, vlist, vgrid, Views };', ctx);
  ctx.api.Views.markPlaying = () => marks++;
  return { ...ctx.api, content, node, pending, observers, events,
    marks: () => marks, geometryReads: () => geometryReads,
    flush() { const frames = [...pending.values()]; pending.clear(); frames.forEach(fn => fn()); },
  };
}

for (const platform of ['windows', 'mac/app']) {
  test(`${platform}: bounded search preserves matching order and limits`, () => {
    const { searchMatches } = frontend(platform);
    const tracks = Array.from({ length: 1000 }, (_, id) => ({ id, s: `${id % 2 ? 'miku' : 'luka'} ${id % 3 ? 'live' : 'studio'} 初音 ${id}` }));
    for (const terms of [[], ['miku'], ['miku', 'studio'], ['初音', 'live'], ['missing']]) {
      for (const limit of [10, 18, 80]) {
        const expected = tracks.filter(t => terms.every(term => t.s.includes(term))).slice(0, limit);
        assert.deepEqual(Array.from(searchMatches(tracks, terms, limit)), expected);
      }
    }
    let reads = 0;
    const large = Array.from({ length: 100000 }, (_, id) => ({ id, get s() { reads++; return 'miku'; } }));
    assert.equal(searchMatches(large, ['miku'], 80).length, 80);
    assert.equal(reads, 80, 'a common search should not scan the remaining 99,920 tracks');
  });

  test(`${platform}: scrolling within mounted rows avoids reconciliation; boundary/resize updates still render`, () => {
    const env = frontend(platform), host = env.node();
    let renders = 0;
    const dispose = env.vlist(host, Array.from({ length: 1000 }, (_, id) => id), 68, () => { renders++; return env.node(); });
    const initial = renders;
    assert.equal(initial, 11);
    env.content.scrollTop = 11; env.events.get('scroll')(); env.flush();
    assert.equal(renders, initial); assert.equal(env.marks(), 1);
    env.content.scrollTop = 80; env.events.get('scroll')(); env.flush();
    assert.equal(renders, initial + 1); assert.equal(env.marks(), 2);
    env.content.clientHeight = 272; env.observers[0].callback(); env.flush();
    assert.equal(renders, initial + 3); assert.equal(env.marks(), 3);
    env.events.get('scroll')(); dispose();
    assert.equal(env.pending.size, 0); assert.equal(env.events.has('scroll'), false);
  });

  test(`${platform}: grid resize events coalesce and pending layout is cancelled on navigation`, () => {
    const env = frontend(platform), host = env.node();
    const dispose = env.vgrid(host, Array.from({ length: 100 }, (_, id) => id), { render: () => env.node() });
    env.observers[0].callback(); env.observers[0].callback(); env.observers[0].callback();
    assert.equal(env.pending.size, 1);
    const reads = env.geometryReads();
    dispose(); env.flush();
    assert.equal(env.pending.size, 0); assert.equal(env.geometryReads(), reads);
  });

  test(`${platform}: a synchronous grid relayout cancels an already queued scroll frame`, () => {
    const env = frontend(platform), host = env.node();
    const dispose = env.vgrid(host, Array.from({ length: 100 }, (_, id) => id), { render: () => env.node() });
    env.events.get('scroll')();
    assert.equal(env.pending.size, 1);
    host.children[0].clientWidth = 800;
    env.observers[0].callback();
    const layoutId = [...env.pending.keys()].at(-1), layout = env.pending.get(layoutId);
    env.pending.delete(layoutId); layout();
    assert.equal(env.pending.size, 0, 'the immediate layout supersedes its pending scroll update');
    dispose();
  });

  test(`${platform}: lyric measurements batch their layout flush and preserve alignment`, () => {
    let heights = 0, layoutReads = 0;
    const lines = Array.from({ length: 500 }, () => ({
      style: {}, classList: { toggle() {} },
      get offsetHeight() { heights++; return 24; },
      get offsetWidth() { layoutReads++; return 300; },
    }));
    const box = { clientHeight: 600, classList: { toggle() {} }, get offsetWidth() {
      layoutReads++;
      assert.ok(lines.every(line => line.style.transitionDuration === '0s'), 'flush after every line has its instant position');
      return 300;
    } };
    const ctx = vm.createContext({ $: () => box, performance: { now: () => 100 }, PageEffects: { reduced: () => false } });
    const source = readFileSync(path.join(root, platform, 'wwwroot/nowplaying.js'), 'utf8').replace(/NowPlaying\.init\(\);\s*$/, 'globalThis.api = NowPlaying;');
    vm.runInContext(source, ctx);
    Object.assign(ctx.api, { lines, active: 50 });
    ctx.api.measure();
    assert.equal(heights, 500); assert.equal(layoutReads, 1, 'one layout flush for the entire lyric sheet');
    assert.equal(ctx.api.tops[50], 1500);
    assert.equal(lines[50].style.transform, 'translateY(204px) scale(1)');
    assert.ok(lines.every(line => line.style.transitionDuration === ''));
    assert.equal(lines[50].style.filter, 'none');
    ctx.api.manualUntil = 200; ctx.api.manualOffset = 40; ctx.api.layoutLines(true);
    assert.equal(lines[50].style.transform, 'translateY(164px) scale(1)');
    assert.ok(lines.every(line => line.style.filter === 'none'));
    assert.equal(layoutReads, 1, 'normal lyric motion needs no forced layout');
  });
}

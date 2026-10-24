'use strict';
// Optional before/after comparison: node benchmark-library.cjs <path-to-original-library.js>
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { loadLibrary, track } = require('./load-library.cjs');
const Current = loadLibrary(), Before = process.argv[2] ? loadLibrary(process.argv[2]) : null;
const source = Array.from({ length: 30000 }, (_, i) => track(String((i * 7919) % 30000), { album: '', added: i, year: 2000 + i % 20 }));
function run(Library) {
  const lib = new Library({}), tracks = source.map(t => ({ ...t }));
  const start = performance.now(); lib.build(tracks, {});
  return { ms: performance.now() - start, data: lib.exportJson() };
}
const samples = { before: [], after: [] };
run(Current);
for (let i = 0; i < 5; i++) {
  const before = Before && run(Before), after = run(Current);
  if (before) { assert.deepEqual(after.data, before.data); samples.before.push(before.ms); }
  samples.after.push(after.ms);
}
const median = a => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
const afterMs = median(samples.after), beforeMs = samples.before.length ? median(samples.before) : null;
console.log(JSON.stringify({ tracks: source.length, iterations: 5, beforeMs, afterMs, speedup: beforeMs && beforeMs / afterMs, identicalExport: !!Before }, null, 2));

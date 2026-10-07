'use strict';
// node mac/tests/dsp-meter.js [previous-dsp-worklet.js]
// Checks real sample output and rate-independent telemetry, including non-default render quanta.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert/strict');
const current = fs.readFileSync(path.resolve(__dirname, '../app/engine/dsp-worklet.js'), 'utf8');
const previous = process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8') : null;
function processor(code, rate) {
  let Processor;
  const messages = [];
  const context = {
    sampleRate: rate,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: m => messages.push(m) }; } },
    registerProcessor: (_name, ctor) => { Processor = ctor; },
  };
  vm.runInNewContext(code, context);
  return { p: new Processor(), messages };
}
const configs = [
  { enabled: false },
  { enabled: true, eqOn: true, autoPreamp: true, bands: [{ on: true, type: 'PK', fc: 1000, q: 1, gain: 6 }] },
  { enabled: true, eqOn: true, preampDb: -4, bands: [{ on: true, type: 'HP', fc: 100, q: 0.7, gain: 0 }] },
  { enabled: true, crossfeed: { on: true, fc: 700, feed: 4.5 }, balance: 0.3, invert: true },
];
const results = [];
for (const rate of [44100, 48000, 192000, 384000]) {
  for (const quantum of [128, 256]) {
    const next = processor(current, rate), old = previous && processor(previous, rate);
    const blocks = Math.ceil(rate / quantum), output = [new Float32Array(quantum), new Float32Array(quantum)];
    const reference = [new Float32Array(quantum), new Float32Array(quantum)];
    for (let block = 0; block < blocks; block++) {
      if (block % Math.floor(blocks / configs.length) === 0) {
        const cfg = configs[Math.min(configs.length - 1, Math.floor(block / Math.floor(blocks / configs.length)))];
        for (const item of [next, old].filter(Boolean)) item.p.port.onmessage({ data: { cfg, gain: 0.8 } });
      }
      const input = [new Float32Array(quantum), new Float32Array(quantum)];
      for (let i = 0; i < quantum; i++) {
        const frame = block * quantum + i;
        input[0][i] = 1.4 * Math.sin(frame * 0.12); input[1][i] = 1.2 * Math.cos(frame * 0.075);
      }
      next.p.process([input], [output]);
      if (old) {
        old.p.process([input], [reference]);
        assert.deepEqual(output, reference, 'DSP audio samples changed');
        assert.equal(next.p.clips, old.p.clips, 'clip accounting changed');
      }
      for (const channel of output) for (const value of channel) assert.ok(Number.isFinite(value) && value <= 1 && value >= -1);
    }
    assert.ok(next.messages.length >= 9 && next.messages.length <= 10, 'telemetry must stay near 10 Hz');
    results.push({ rate, quantum, reports: next.messages.length, previousReports: old?.messages.length, identicalAudio: old ? true : undefined });
  }
}
console.log(JSON.stringify({ passed: true, results }, null, 2));

'use strict';
// node mac/tests/native-audio.js [--hardware]
// Without --hardware: helper self-test, byte-exact decoding, signal-label safeguards, native DSP = existing DSP.
// With --hardware: plays silence only, on a real DAC (MIKU_TEST_DAC=<part of its name>, else the first USB output),
// and checks bit-perfect setup, song changes, seeks, output switches while playing, follow-the-system-output without
// ping-pong, shared mode, and that every device is put back the way it was.
const assert = require('assert/strict'), fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync, spawn } = require('child_process');
const readline = require('readline');
const base = path.resolve(__dirname, '..');
const helper = process.env.MIKU_AUDIO_HELPER || path.join(base, 'build/native', 'miku-audio-' + process.arch);
const ffmpeg = process.env.MIKU_TEST_FFMPEG || [path.join(base, 'build/work/root-' + process.arch, 'MIKU.app/Contents/Resources/bin/ffmpeg'),
  '/Applications/MIKU.app/Contents/Resources/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(p => fs.existsSync(p));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miku-native-audio-'));
const delay = ms => new Promise(r => setTimeout(r, ms));
function wav(rate, bits, channels, seconds = 0, silent = false) {
  const frames = seconds ? Math.round(rate * seconds) : 4096, bytes = bits / 8;
  const data = Buffer.alloc(44 + frames * channels * bytes), pcm = Buffer.alloc(frames * channels * 4);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(channels, 22); data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * channels * bytes, 28); data.writeUInt16LE(channels * bytes, 32); data.writeUInt16LE(bits, 34);
  data.write('data', 36); data.writeUInt32LE(data.length - 44, 40);
  let random = 0x31415926;
  for (let i = 0; i < frames * channels; ++i) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const value = silent ? 0 : random | 0;
    const sample = bits === 32 ? value : value >> (32 - bits);
    data.writeIntLE(sample, 44 + i * bytes, bytes); pcm.writeInt32LE(bits === 32 ? sample : sample * 2 ** (32 - bits), i * 4);
  }
  const file = path.join(root, `${rate}-${bits}-${channels}-${seconds}-${silent ? 'silent' : 'random'}.wav`);
  fs.writeFileSync(file, data); return { file, pcm, frames, rate, bits, channels, duration: frames / rate };
}
function client() {
  const proc = spawn(helper, [], { stdio: ['pipe', 'pipe', 'pipe'] }), lines = readline.createInterface({ input: proc.stdout });
  let seq = 0; const pending = new Map(), events = [];
  lines.on('line', line => {
    const m = JSON.parse(line); events.push(m);
    const done = pending.get(m.seq); if (done) { pending.delete(m.seq); done(m); }
  });
  proc.stderr.on('data', d => process.stderr.write(d));
  const send = m => proc.stdin.write(JSON.stringify(m) + '\n');
  const request = (m, ms = 20000) => new Promise((resolve, reject) => {
    m.seq = ++seq; const timer = setTimeout(() => { pending.delete(m.seq); reject(new Error('Helper timeout: ' + m.c)); }, ms);
    pending.set(m.seq, result => { clearTimeout(timer); resolve(result); }); send(m);
  });
  const lastStatus = () => [...events].reverse().find(e => e.e === 'status');
  return { proc, events, send, request, lastStatus, async close() { const done = new Promise(r => proc.once('exit', r)); proc.stdin.end(); await done; lines.close(); } };
}
async function main() {
  const self = JSON.parse(execFileSync(helper, ['--self-test'], { encoding: 'utf8' })); assert(self.ok);
  console.log(`Helper self-test: ${self.samplesVerified} samples (${self.tests.join(', ')})`);
  assert(ffmpeg, 'FFmpeg not found; set MIKU_TEST_FFMPEG');
  for (const bits of [16, 24, 32]) for (const channels of [1, 2]) {
    const f = wav(48000, bits, channels);
    const decoded = JSON.parse(execFileSync(helper, ['--decode-test', ffmpeg, f.file, String(f.rate), String(bits), String(channels)], { encoding: 'utf8' }));
    assert(decoded.ok, decoded.error); assert.deepEqual(Buffer.from(decoded.pcm, 'base64'), f.pcm, `${bits}-bit ${channels}ch PCM differs`);
    if (bits < 32) {
      const flac = f.file + '.flac'; execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', f.file, '-c:a', 'flac', flac]);
      const lossless = JSON.parse(execFileSync(helper, ['--decode-test', ffmpeg, flac, '48000', String(bits), String(channels)], { encoding: 'utf8' }));
      assert.deepEqual(Buffer.from(lossless.pcm, 'base64'), f.pcm, 'FLAC samples differ');
    }
  }
  // Signal labels must not claim exactness after gain, DSP, SRC, lost ownership, or insufficient precision.
  const Module = require('module'), load = Module._load;
  Module._load = function(id, ...args) {
    if (id === 'electron') return { app: { getPath: () => root }, ipcMain: { on() {} }, globalShortcut: { register: () => true, unregister() {} } };
    return load.call(this, id, ...args);
  };
  const { NativeAudioEngine } = require('../app/main/native-audio'); Module._load = load;
  const settings = { dsp: { enabled: false }, volumeMode: 'fixed', volumeDb: 0, replayGain: 'off', muted: false };
  const engine = new NativeAudioEngine(settings), track = { codec: 'FLAC', sampleRate: 48000, bits: 24 };
  engine.decode = { rate: 48000, bits: 24, integerSource: true }; engine.st.rate = 48000;
  const hardware = { open: true, rate: 48000, exclusive: true, exactPath: true, precisionBits: 24, outputBits: 32, gainUnity: true, replayGainUnity: true, dspActive: false };
  engine.hardware = { ...hardware }; assert.equal(engine.buildSignal(track).quality, 'bitperfect');
  for (const patch of [{ exclusive: false }, { exactPath: false }, { precisionBits: 16 }, { gainUnity: false }, { replayGainUnity: false }, { dspActive: true }, { rate: 96000 }, { open: false }]) {
    engine.hardware = { ...hardware, ...patch }; assert.notEqual(engine.buildSignal(track).quality, 'bitperfect');
  }
  engine.hardware = { ...hardware }; settings.dsp.enabled = true; assert.notEqual(engine.buildSignal(track).quality, 'bitperfect');
  settings.dsp.enabled = false; settings.volumeMode = 'digital'; settings.volumeDb = -3; assert.notEqual(engine.buildSignal(track).quality, 'bitperfect');
  settings.volumeMode = 'fixed'; settings.muted = true; assert.notEqual(engine.buildSignal(track).quality, 'bitperfect');
  settings.muted = false; engine.decode.integerSource = false; assert.notEqual(engine.buildSignal(track).quality, 'bitperfect');
  engine.decode.integerSource = true; assert.equal(engine.buildSignal({ ...track, codec: 'MP3' }).quality, 'low');
  console.log(`Native PCM checks passed: 6 WAV/4 FLAC byte comparisons, signal safeguards`);
  const vm = require('vm'), code = fs.readFileSync(path.join(base, 'app/engine/dsp-worklet.js'), 'utf8');
  const context = vm.createContext({ sampleRate: 48000, AudioWorkletProcessor: class {}, registerProcessor() {} }); vm.runInContext(code, context);
  const configs = [{ enabled: false }, { enabled: true, eqOn: true, autoPreamp: true, bands: [{ on: true, type: 'PK', fc: 1000, q: 1, gain: 6 }] },
    { enabled: true, eqOn: true, preampDb: -4, bands: [{ on: true, type: 'HP', fc: 100, q: 0.7, gain: 0 }, { on: true, type: 'LSC', fc: 200, q: 0.7, gain: -3 }] },
    { enabled: true, crossfeed: { on: true, fc: 700, feed: 4.5 }, balance: 0.3, invert: true }];
  for (const rate of [44100, 48000, 192000]) for (const cfg of configs) {
    const file = path.join(root, 'dsp.json'); fs.writeFileSync(file, JSON.stringify({ cfg, rate }));
    const native = JSON.parse(execFileSync(helper, ['--dsp-test', file], { encoding: 'utf8' }));
    context.cfg = cfg; context.rate = rate;
    const reference = vm.runInContext(`(() => { const g = buildGraph(cfg, rate), samples = [];
      for (let i = 0; i < 512; ++i) { const o = { l: 0.6*Math.sin(i*0.12), r: 0.4*Math.cos(i*0.075) }; run(g, o); samples.push(o.l, o.r); }
      return { samples, limit: g.limit, active: g.active }; })()`, context);
    assert.equal(native.active, reference.active); assert(Math.abs(native.limit - reference.limit) < 1e-12);
    native.samples.forEach((v, i) => assert(Math.abs(v - reference.samples[i]) < 1e-10, 'Native DSP differs from existing DSP'));
  }
  console.log('Native DSP matches existing DSP: 12 rate/configuration comparisons');
  if (!process.argv.includes('--hardware')) return;

  // ───────────── hardware ─────────────
  const list = JSON.parse(execFileSync(helper, ['--devices'], { encoding: 'utf8' })).devices.filter(d => !d.isDefault);
  const wanted = process.env.MIKU_TEST_DAC;
  const dac = wanted ? list.find(d => d.name.includes(wanted)) : list.find(d => d.transport === 'usb' && d.exclusiveSupported);
  if (!dac) { console.log('No USB DAC found (set MIKU_TEST_DAC=<name>): hardware checks skipped'); return; }
  // the second output for switch tests: the built-in output first (virtual devices may not make a sound)
  const others = list.filter(d => d.id !== dac.id && d.ownerPid === -1 && !['bluetooth', 'airplay'].includes(d.transport));
  const other = others.find(d => d.transport === 'builtin') || others.find(d => d.transport !== 'virtual') || others[0];
  assert.equal(dac.ownerPid, -1, 'DAC is already owned by another app');
  console.log(`Hardware: ${dac.name} (${dac.rate / 1000} kHz, ${dac.physicalFormat}; rates ${dac.rates.map(r => r / 1000).join('/')})` + (other ? `, second output ${other.name}` : ''));
  const a = client(), b = client();
  const config = (f, extra = {}) => ({ c: 'load', id: 'hw-' + path.basename(f.file), ffmpeg, path: f.file, rate: f.rate, bits: f.bits, channels: f.channels,
    duration: f.duration, pos: 0, rg: 1, gain: 1, dsp: { enabled: false }, autoRate: true, integerSource: true, device: dac.id, exclusive: true, play: false, ...extra });
  const restored = async (d, label) => {
    const p = (await a.request({ c: 'probe', device: d.id })).caps;
    assert.equal(p.ownerPid, -1, label + ': hog released'); assert.equal(p.rate, d.rate, label + ': rate put back');
    assert.equal(p.physicalFormat, d.physicalFormat, label + ': DAC format put back');
  };
  try {
    // 1. Exclusive at each rate: actual rate, hog, a DAC format with ≥ 24 bits, another client refused; state put back.
    for (const rate of [44100, 48000, 96000, 192000].filter(r => dac.rates.includes(r))) {
      // exclusive mode takes hog mode once playback starts, so each rate is played (silence) briefly
      const f = wav(rate, 24, 2, 3, true), loaded = await a.request(config(f, { play: true }));
      assert(loaded.ok, loaded.msg); assert.equal(loaded.hardware.rate, rate); assert.equal(loaded.hardware.exclusive, true); assert.equal(loaded.hardware.hogHeld, true);
      assert.equal(loaded.hardware.exactPath, true, 'exclusive USB output must be a direct path');
      const probe = await a.request({ c: 'probe', device: dac.id });
      assert.equal(probe.caps.rate, rate); assert.equal(probe.caps.ownerPid, a.proc.pid);
      // a rate change pauses the IO while the DAC relocks (about 1 s on some DACs)
      await delay(1600); const moving = a.lastStatus(); assert(moving && moving.playing && moving.pos > 0.2, `${rate / 1000} kHz: playback not moving (${moving && moving.pos})`);
      const conflict = await b.request(config(f, { play: true })); assert.equal(conflict.ok, false); assert.match(conflict.msg, /獨佔/);
      console.log(`  ${rate / 1000} kHz: ${loaded.hardware.outputFormat} → DAC ${loaded.hardware.physicalFormat}, precision ${loaded.hardware.precisionBits}-bit`);
      if (loaded.hardware.precisionBits < 24) console.log(`  ⚠ ${dac.name} offers only ${loaded.hardware.precisionBits}-bit at ${rate / 1000} kHz`);
      await a.request({ c: 'stop' }); await restored(dac, `${rate / 1000} kHz`);
    }
    console.log('Exclusive setup per rate: confirmed, conflict refused, device put back');
    // 2. Song changes while playing: same rate swaps decks without stopping the device; a rate change relocks.
    let t0 = Date.now(), r = await a.request(config(wav(48000, 24, 2, 4, true), { play: true })); assert(r.ok, r.msg);
    const firstLoad = Date.now() - t0; await delay(300);
    t0 = Date.now(); r = await a.request(config(wav(48000, 16, 2, 4, true), { play: true })); assert(r.ok, r.msg);
    const sameRate = Date.now() - t0; assert.equal(r.hardware.rate, 48000); assert(r.playing);
    // rate changes while playing (the device keeps running and relocks), quick ones included
    const changes = [];
    for (const rate of [96000, 44100, 192000, 48000, 88200, 44100].filter(x => dac.rates.includes(x))) {
      t0 = Date.now(); r = await a.request(config(wav(rate, 24, 2, 4, true), { play: true })); changes.push(Date.now() - t0);
      assert(r.ok, r.msg); assert.equal(r.hardware.rate, rate); assert(r.playing, `playing after the change to ${rate / 1000} kHz`);
      await delay(changes.length % 2 ? 150 : 900);
    }
    assert(Math.max(...changes) < 4000, `a rate change took ${Math.max(...changes)} ms`);
    { await delay(800); const p0 = a.lastStatus().pos; await delay(800); const s = a.lastStatus(); assert(s.playing && s.pos > p0 + 0.3, `playback not moving after the rate changes (${p0} → ${s.pos})`); }
    console.log(`Song changes: first open ${firstLoad} ms, same-rate change ${sameRate} ms (device kept running), rate changes ${changes.join(' / ')} ms`);
    // 3. Seek in place while playing; position continues from there.
    await delay(500);
    r = await a.request({ c: 'seek', pos: 2.5, play: true }); assert(r.ok, r.msg);
    await delay(400); const st = a.lastStatus(); assert(st.playing && st.pos > 2.6 && st.pos < 3.5, 'seek position ' + (st && st.pos));
    assert.equal(st.underruns, 0, 'no buffer underrun after a seek');
    console.log(`Seek while playing: continues at ${st.pos.toFixed(2)} s, no underrun`);
    // 3b. Pause / resume, also right after a rate change: Play continues at once and the place is kept.
    const resumes = [];
    for (const rate of [dac.rates.includes(96000) ? 96000 : 48000, 44100, 44100]) {
      r = await a.request(config(wav(rate, 24, 2, 6, true), { play: true, pos: 1 })); assert(r.ok, r.msg); await delay(200);
      a.send({ c: 'pause' }); await delay(500);
      const paused = a.lastStatus(); assert(!paused.playing, 'paused');
      t0 = Date.now(); r = await a.request({ c: 'resume' }); resumes.push(Date.now() - t0);
      assert(r.ok, r.msg); assert(r.playing, 'playing after resume'); assert(Math.abs(r.pos - paused.pos) < 0.2, `place kept across pause (${paused.pos} → ${r.pos})`);
      await delay(1200); const s = a.lastStatus(); assert(s.playing && s.pos > r.pos + 0.3, `moving after resume (${r.pos} → ${s.pos})`);
    }
    assert(Math.max(...resumes) < 1000, `resume took ${Math.max(...resumes)} ms`);
    console.log(`Pause / resume (also right after a rate change): resume ${resumes.join(' / ')} ms, place kept`);
    // 4. Output switches while playing keep the place (no reload) and the old device is put back.
    if (other) {
      const long = wav(48000, 24, 2, 60, true);
      r = await a.request(config(long, { play: true })); assert(r.ok, r.msg); await delay(1500);
      const before = a.lastStatus().pos;
      t0 = Date.now(); r = await a.request({ c: 'config', device: other.id, exclusive: true, autoRate: true }); const toOther = Date.now() - t0;
      assert(r.ok, r.msg); assert.equal(r.hardware.deviceUID, other.id); assert(r.playing, 'still playing after the switch');
      assert(Math.abs(r.pos - before) < 0.5, `place kept across the switch (${before} → ${r.pos})`);
      await restored(dac, 'DAC after switching away');
      await delay(1500); assert(a.lastStatus().pos > r.pos, 'playing on the second output');
      t0 = Date.now(); r = await a.request({ c: 'config', device: dac.id, exclusive: true, autoRate: true }); const back = Date.now() - t0;
      assert(r.ok, r.msg); assert.equal(r.hardware.deviceUID, dac.id); assert.equal(r.hardware.exclusive, true); assert(r.playing);
      await delay(300); await restored(other, 'second output after switching back');
      // shared ↔ exclusive on the same DAC
      r = await a.request({ c: 'config', device: dac.id, exclusive: false, autoRate: true }); assert(r.ok, r.msg); assert.equal(r.hardware.exclusive, false);
      assert.equal((await a.request({ c: 'probe', device: dac.id })).caps.ownerPid, -1, 'shared mode must not hog');
      r = await a.request({ c: 'config', device: dac.id, exclusive: true, autoRate: true }); assert(r.ok, r.msg); assert.equal(r.hardware.exclusive, true);
      // quick switching back and forth: only the newest takes effect, playback survives
      for (const id of [other.id, dac.id, other.id, dac.id]) a.send({ c: 'config', device: id, exclusive: true, autoRate: true, seq: 9000 });
      r = await a.request({ c: 'config', device: dac.id, exclusive: true, autoRate: true }); assert(r.ok, r.msg);
      await delay(1500); const after = a.lastStatus(); assert(after.playing && after.deviceUID === dac.id, 'playing on the DAC after quick switches');
      console.log(`Output switches while playing: to ${other.name} ${toOther} ms, back ${back} ms; place kept, devices put back, quick switching survives`);
      // back and forth while playing (also through "system output"), waiting for each: every switch keeps playing and moving on
      for (const exclusive of [true, false]) {
        const times = [];
        const targets = [other.id, dac.id, 'default', other.id, 'default', dac.id];
        for (let i = 0; i < targets.length; ++i) {
          t0 = Date.now(); r = await a.request({ c: 'config', device: targets[i], exclusive, autoRate: true });
          assert(r.ok, `switch ${i + 1} to ${targets[i]}: ${r.msg}`); assert(r.playing, `switch ${i + 1} to ${targets[i]} left playback paused`);
          times.push(Date.now() - t0);
          const p0 = r.pos; await delay(1500); const s = a.lastStatus();
          assert(s && s.playing && s.pos > p0 + 0.3, `switch ${i + 1} to ${targets[i]}: playback not moving (${p0} → ${s && s.pos})`);
          if (targets[i] !== 'default') assert.equal(s.deviceUID, targets[i], `switch ${i + 1} went to ${s.deviceName}`);
          console.log(`  ${exclusive ? 'exclusive' : 'shared'} → ${targets[i] === 'default' ? 'system output' : s.deviceName}: ${times.at(-1)} ms, now on ${s.deviceName} @ ${s.rate} Hz`);
        }
        console.log(`Back-and-forth switching (${exclusive ? 'exclusive' : 'shared'}): ${times.join(' / ')} ms, playing after every switch`);
      }
      r = await a.request({ c: 'config', device: dac.id, exclusive: true, autoRate: true }); assert(r.ok, r.msg);
    } else console.log('Only one output device: output switch checks skipped');
    // 5. Following the system output while hogging it must not ping-pong.
    const outputs = () => a.events.filter(e => e.e === 'output' && e.reason === 'default').length;
    const n0 = outputs();
    r = await a.request(config(wav(48000, 24, 2, 10, true), { device: 'default', play: true })); assert(r.ok, r.msg);
    await delay(4000);
    assert(outputs() - n0 <= 1, 'following the system output while exclusive must not move back and forth');
    assert(a.lastStatus().playing, 'still playing on the system output');
    console.log(`System output followed in exclusive mode on ${r.hardware.deviceName}: stable`);
    await a.request({ c: 'stop' }); await delay(300);
    // 6. A rate the DAC lacks: nearest supported rate, resampled and labelled.
    const unsupported = await a.request(config(wav(12345, 24, 2, 1, true), { play: true }));
    assert(unsupported.ok, unsupported.msg); assert.notEqual(unsupported.hardware.rate, 12345); assert.equal(unsupported.hardware.exclusive, true);
    await a.request({ c: 'stop' }); await restored(dac, 'after fallback rate');
    console.log(`12.345 kHz falls back to ${unsupported.hardware.rate / 1000} kHz with resampling; state restored`);
    // 7. Shared mode: no hog, the rate still follows the track, and it is put back; another app's hog blocks it.
    const target = [96000, 88200, 48000, 44100].find(x => x !== dac.rate && dac.rates.includes(x));
    if (target) {
      const shared = await a.request(config(wav(target, 24, 2, 3, true), { exclusive: false }));
      assert(shared.ok, shared.msg); assert.equal(shared.hardware.exclusive, false); assert.equal(shared.hardware.rate, target);
      const sp = await a.request({ c: 'probe', device: dac.id }); assert.equal(sp.caps.ownerPid, -1); assert.equal(sp.caps.rate, target);
      await a.request({ c: 'stop' }); await restored(dac, 'shared mode');
      // another app's exclusive (a second helper) shuts shared playback out
      const held = await b.request(config(wav(target, 24, 2, 1, true), { play: true })); assert(held.ok, held.msg);
      const blocked = await a.request(config(wav(target, 24, 2, 1, true), { exclusive: false })); assert.equal(blocked.ok, false); assert.match(blocked.msg, /獨佔/);
      await b.request({ c: 'stop' }); await restored(dac, "after the other app's exclusive");
      console.log(`Shared mode at ${target / 1000} kHz without hog, another app's exclusive respected, rate restored`);
    }
    console.log('Hardware checks passed');
  } finally { await Promise.all([a.close(), b.close()]); }
}
main().then(() => fs.rmSync(root, { recursive: true, force: true })).catch(e => { console.error(e); process.exitCode = 1; });

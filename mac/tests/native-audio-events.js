'use strict';
// node mac/tests/native-audio-events.js
// The app side of the native output against a fake helper process (no DAC, no Core Audio needed): output switches,
// seeks and ReplayGain go to the helper without reloading the track, an unplugged device pauses at its place and Play
// continues there, the helper's own output moves are mirrored, failures are reported, a crashed helper is restarted.
const assert = require('assert/strict'), fs = require('fs'), os = require('os'), path = require('path');
const Module = require('module');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miku-native-events-'));
const log = path.join(root, 'commands.log');
const helper = path.join(root, 'fake-helper.js');
fs.writeFileSync(helper, `#!${process.execPath}
const fs = require('fs'), log = ${JSON.stringify(log)};
const out = m => process.stdout.write(JSON.stringify(m) + '\\n');
let playing = false, device = 'default', exclusive = false, rate = 48000, failNext = null;
const hw = () => ({ open: true, rate, deviceUID: device === 'default' ? 'speakers' : device, deviceName: device === 'default' ? 'Speakers' : 'DAC ' + device,
  exclusive, exactPath: exclusive, precisionBits: 24, physicalFormat: '24-bit PCM', outputFormat: '32-bit 浮點', gainUnity: true, replayGainUnity: true,
  fallbackDevice: device === 'gone-dac', transport: 'usb' });
out({ e: 'hello', version: 3 });
require('readline').createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line); fs.appendFileSync(log, JSON.stringify(m) + '\\n');
  if (m.c === 'crash') process.exit(3);
  if (m.c === 'failNext') { failNext = m.what; return; }
  if (m.c === 'emit') { out(m.event); return; }
  const fail = failNext === m.c; if (fail) failNext = null;
  if (m.c === 'load') {
    if (fail) return out({ e: 'loaded', seq: m.seq, ok: false, msg: 'FFmpeg 無法解碼這首歌的 PCM 資料' });
    device = m.device; exclusive = !!m.exclusive; rate = m.rate; playing = !!m.play;
    setTimeout(() => out({ e: 'loaded', seq: m.seq, ok: true, playing, hardware: hw() }), /slow/.test(m.path) ? 300 : 0);
  }
  if (m.c === 'config') {
    if (fail) { playing = false; return out({ e: 'configured', seq: m.seq, ok: false, msg: '輸出裝置已離線', pos: 77 }); }
    device = m.device; exclusive = !!m.exclusive;
    setTimeout(() => out({ e: 'configured', seq: m.seq, ok: true, playing, pos: 61, hardware: hw() }), 50);
  }
  if (m.c === 'seek') {
    if (fail) return out({ e: 'seeked', seq: m.seq, ok: false, msg: 'FFmpeg 解碼逾時' });
    playing = !!m.play; out({ e: 'seeked', seq: m.seq, ok: true, pos: m.pos, playing });
  }
  if (m.c === 'resume') {
    if (fail) return out({ e: 'resumed', seq: m.seq, ok: false, msg: '找不到可用的輸出裝置' });
    playing = true; out({ e: 'resumed', seq: m.seq, ok: true, playing, pos: 42.5, hardware: hw() });
  }
  if (m.c === 'pause') { playing = false; out({ e: 'status', ...hw(), id: 't1', pos: 50, dur: 200, playing, l: 0, r: 0, clips: 0, underruns: 0 }); }
  if (m.c === 'stop') out({ e: 'stopped', seq: m.seq });
  if (m.c === 'devices') out({ e: 'devices', seq: m.seq, list: [{ id: 'default', name: 'Speakers', isDefault: true }, { id: 'gone-dac', name: 'DAC' }] });
});
`);
fs.chmodSync(helper, 0o755);
process.env.MIKU_AUDIO_HELPER = helper;

const load = Module._load;
Module._load = function(id, ...args) {
  if (id === 'electron') return { app: { getPath: () => root }, ipcMain: { on() {}, removeListener() {} }, globalShortcut: { register: () => true, unregister() {} }, BrowserWindow: class {} };
  return load.call(this, id, ...args);
};
const ff = require('../app/main/ffmpeg');
const { NativeAudioEngine } = require('../app/main/native-audio');
Module._load = load;
ff.Ffmpeg.path = '/bin/true'; Object.defineProperty(ff.Ffmpeg, 'available', { get: () => true, configurable: true });
let probes = 0;
ff.probe = async () => { ++probes; return { streams: [{ codec_type: 'audio', sample_rate: '48000', sample_fmt: 's32', bits_per_raw_sample: '24', channels: 2 }] }; };

const delay = ms => new Promise(r => setTimeout(r, ms));
const commands = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const sent = c => commands().filter(x => x.c === c);
async function until(fn, label, ms = 5000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await delay(20); } throw new Error('Timed out: ' + label); }

async function main() {
  const settings = { dsp: { enabled: false }, volumeMode: 'fixed', volumeDb: 0, replayGain: 'off', muted: false, outputMode: 'coreaudio-exclusive',
    autoSampleRate: true, gapless: true, deviceId: null, dsdPcmRate: 176400 };
  const engine = new NativeAudioEngine(settings), failures = [];
  engine.on('failed', m => failures.push(m));
  engine.start(); await engine.ready;
  const track = { id: 't1', path: '/music/a.flac', title: 'A', codec: 'FLAC', sampleRate: 48000, bits: 24, channels: 2, duration: 200 };

  // 1. A load carries the wanted output; exclusive with a direct path is bit-perfect, shared never is.
  await engine.load(track, 10, true);
  assert(engine.isLoaded && engine.isPlaying);
  let l = sent('load').at(-1); assert.equal(l.exclusive, true); assert.equal(l.autoRate, true); assert.equal(l.pos, 10); assert.equal(l.device, 'default');
  assert.equal(engine.signal.quality, 'bitperfect', 'exclusive, same rate, 24-bit DAC format: bit-perfect');
  assert.match(engine.signal.note, /DAC 格式 24-bit PCM/);

  // 2. Bit-perfect rules on the float path.
  const base = { ...engine.hardware };
  const quality = patch => { engine.hardware = { ...base, ...patch }; return engine.buildSignal(track).quality; };
  assert.equal(quality({}), 'bitperfect');
  for (const patch of [{ exclusive: false }, { exactPath: false }, { precisionBits: 16 }, { gainUnity: false }, { replayGainUnity: false }, { dspActive: true }, { rate: 96000 }, { open: false }])
    assert.notEqual(quality(patch), 'bitperfect', JSON.stringify(patch));
  assert.match((engine.hardware = { ...base, exactPath: false, transport: 'bluetooth' }, engine.buildSignal(track).note), /藍牙/);
  engine.hardware = { ...base }; engine.decode = { ...engine.decode, bits: 32 }; assert.notEqual(engine.buildSignal(track).quality, 'bitperfect', '32-bit integer exceeds the float path');
  engine.decode = { ...engine.decode, bits: 16 }; engine.hardware = { ...base, precisionBits: 16 }; assert.equal(engine.buildSignal(track).quality, 'bitperfect', '16-bit music on a 16-bit DAC format');
  engine.decode = { ...engine.decode, bits: 24 }; engine.hardware = { ...base };
  settings.volumeMode = 'digital'; settings.volumeDb = -3; assert.equal(engine.buildSignal(track).quality, 'enhanced'); settings.volumeMode = 'fixed';
  settings.dsp.enabled = true; assert.equal(engine.buildSignal(track).quality, 'enhanced'); settings.dsp.enabled = false;
  engine.st.underruns = 2; assert.equal(engine.buildSignal(track).quality, 'enhanced'); engine.st.underruns = 0;
  assert.equal(engine.buildSignal({ ...track, codec: 'MP3' }).quality, 'low');

  // 3. Switching the output while playing: one `config`, no reload, the place and play state are kept.
  let loads = sent('load').length;
  settings.deviceId = 'dac-2'; await engine.setDevice();
  assert.equal(sent('load').length, loads, 'an output switch must not reload the track');
  let cfg = sent('config').at(-1); assert.equal(cfg.device, 'dac-2'); assert.equal(cfg.exclusive, true);
  assert(engine.isLoaded && engine.isPlaying); assert.equal(engine.hardware.deviceUID, 'dac-2'); assert(Math.abs(engine.position - 61) < 0.5);
  // shared ↔ exclusive is a config too
  settings.outputMode = 'coreaudio'; await engine.applyOutput();
  assert.equal(sent('load').length, loads); assert.equal(sent('config').at(-1).exclusive, false);
  assert.equal(engine.signal.mode, 'Core Audio 共享'); assert.notEqual(engine.signal.quality, 'bitperfect');
  settings.outputMode = 'coreaudio-exclusive'; await engine.applyOutput();

  // 4. A failed switch pauses at the helper's place and says so; Play continues (the helper opens what is there).
  engine.send({ c: 'failNext', what: 'config' }); await delay(30);
  settings.deviceId = 'gone-dac'; await engine.setDevice();
  assert(!engine.isPlaying && engine.isLoaded); assert.equal(engine.position, 77); assert.match(failures.at(-1), /無法切換輸出：輸出裝置已離線/);
  await engine.resume(); assert(engine.isPlaying); assert.equal(sent('load').length, loads, 'Play after a failed switch resumes, not reloads');

  // 5. Seeking swaps the decoder in the helper (no reload); a failed seek falls back to a reload at that place.
  await engine.seek(120); assert.equal(sent('seek').at(-1).pos, 120); assert.equal(sent('seek').at(-1).play, true);
  assert.equal(sent('load').length, loads); assert(Math.abs(engine.position - 120) < 0.5);
  engine.send({ c: 'failNext', what: 'seek' }); await delay(30);
  await engine.seek(130); assert.equal(sent('load').length, loads + 1); assert.equal(sent('load').at(-1).pos, 130); loads++;

  // 6. The DAC is unplugged while playing: paused at the same place, still loaded, said so; Play resumes there.
  engine.onMsg({ e: 'lost', reason: 'gone', pos: 42.5, playing: false, wasPlaying: true, msg: '「DX1 II」已中斷連線' });
  assert(engine.isLoaded && !engine.isPlaying); assert.equal(engine.position, 42.5); assert.equal(settings.resumePosition, 42.5);
  assert.match(failures.at(-1), /已中斷連線，已暫停播放。重新連接或選擇其他輸出後，按播放即可從原位置繼續/);
  assert.equal(engine.track, track); assert.equal(engine.signal.quality === 'bitperfect', false, 'no output open: no bit-perfect badge');
  await engine.resume(); assert(engine.isPlaying); assert.equal(sent('resume').length >= 2, true); assert.equal(sent('load').length, loads);
  // … and a resume that can't open anything says why
  engine.onMsg({ e: 'lost', reason: 'gone', pos: 43, playing: false, wasPlaying: true, msg: 'x' });
  engine.send({ c: 'failNext', what: 'resume' }); await delay(30);
  await engine.resume(); assert(!engine.isPlaying); assert.match(failures.at(-1), /無法繼續播放：找不到可用的輸出裝置/);
  await engine.resume(); assert(engine.isPlaying);

  // 7. The helper followed the system output by itself: mirrored, play state kept, the preload is redone.
  engine.preloadedFor = { id: 'x' };
  engine.onMsg({ e: 'output', reason: 'default', playing: true, pos: 44, hardware: { ...base, deviceUID: 'headphones', deviceName: 'Headphones' } });
  assert.equal(engine.hardware.deviceUID, 'headphones'); assert(engine.isPlaying); assert.equal(engine.preloadedFor, null); assert.equal(engine.signal.device, 'Headphones');

  // 8. A switch during a load: the newest choice wins, at the loading place and state, and is not a failure.
  const slow = { ...track, id: 'slow', path: '/music/slow.flac', duration: 300 };
  settings.deviceId = null; settings.resumePosition = 999;
  const first = engine.load(slow, 120, true);
  await delay(50); assert.equal(engine.position, 120, 'position while loading is the one being loaded');
  settings.deviceId = 'dac'; const second = engine.setDevice();
  await first; assert.equal(engine.loadFailed, false, 'a replaced load must not count as a failure');
  await second;
  l = sent('load').at(-1); assert.equal(l.device, 'dac'); assert.equal(l.pos, 120); assert.equal(l.play, true);
  assert(engine.isLoaded && engine.isPlaying);

  // 9. A stray "ended" from the deck being replaced does not end the song; a real failure is reported as one.
  let ended = 0; engine.on('ended', () => ended++);
  const third = engine.load(slow, 130, true); await delay(20);
  engine.onMsg({ e: 'ended' }); await third;
  assert.equal(ended, 0); assert(engine.isLoaded);
  engine.send({ c: 'failNext', what: 'load' }); await delay(30);
  await engine.load(slow, 0, true); assert.equal(engine.loadFailed, true); assert.equal(engine.lastFailureWasDevice, false);
  await engine.load(track, 30, true);

  // 10. A failed preload of the same next track is not retried on every status message.
  const next = { ...track, id: 't2', path: '/music/b.flac' };
  engine.peekNext = () => next; engine.st.dur = 200; engine.st.pos = 190; engine.st.rate = 48000; probes = 0;
  assert(engine.isPlaying);
  for (let i = 0; i < 5; ++i) { await engine.maybePreload(); engine.onMsg({ e: 'preloadFailed', msg: 'test' }); }
  assert.equal(probes, 1, 'preload must not probe the same next track repeatedly');
  await until(() => sent('preload').length === 1, 'preload sent'); await delay(100);
  assert.equal(sent('preload').length, 1);
  // gapless handoff inside the helper
  engine.preloadedFor = next; engine.onMsg({ e: 'started', id: 't2', hardware: base });
  assert.equal(engine.track, next); assert(engine.isLoaded);

  // 11. The helper crashes: a new one is started and playback continues where it was.
  engine.restarts = [];
  await engine.load(track, 30, true); const oldPid = engine.proc.pid; loads = sent('load').length;
  engine.st.pos = 31; engine.statusAt = Date.now();
  engine.send({ c: 'crash' });
  await until(() => engine.proc && engine.proc.pid !== oldPid && sent('load').length === loads + 1 && engine.isLoaded, 'helper restart');
  l = sent('load').at(-1); assert(Math.abs(l.pos - 31) < 0.5); assert.equal(l.play, true);

  // 12. Nothing loaded: an output change is only remembered by the helper.
  engine.stop(); const configs = sent('config').length;
  settings.deviceId = 'dac-3'; await engine.setDevice(); await delay(50);
  assert.equal(sent('config').length, configs + 1); assert(!engine.isLoaded);
  await engine.dispose();
  console.log('Native audio event checks passed: bit-perfect rules, output switch without reload, failed switch, seek in place, unplug pause/resume, helper output moves, switch during load, stray end, real failure, preload retry, gapless, helper restart');
}
main().then(() => fs.rmSync(root, { recursive: true, force: true }), e => { console.error(e); process.exitCode = 1; });

'use strict';
// The native Core Audio output (mac/native/audio.mm): shared or exclusive, like WASAPI on Windows.
//
// The helper owns the output device and the decoders. Switching the output (here or in macOS), a returning DAC and
// outside rate changes are handled there without reloading the track: the decoded audio is kept, so playback goes on
// from the same sample. This side sends the wanted output with every load and as `config` when it changes, and mirrors
// what the helper reports ("output" / "lost" events). If the helper ever dies it is started again and playback
// continues where it was.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { globalShortcut } = require('electron');
const { WebAudioEngine } = require('./web-audio');
const { isDsd } = require('./library');
const { Log } = require('./common');
const ff = require('./ffmpeg');

const Protocol = 3;
function helperPath() {
  const candidates = [process.env.MIKU_AUDIO_HELPER,
    process.resourcesPath && path.join(process.resourcesPath, 'bin', 'miku-audio'),
    path.join(__dirname, '..', '..', 'build', 'native', `miku-audio-${process.arch}`)];
  return candidates.find(p => { if (!p) return false; try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null;
}

const khz = r => (r / 1000).toFixed(1).replace(/\.0$/, '');
// Output changes after which the helper dropped its preloaded next track.
const DropsPreload = new Set(['default', 'returned', 'rate']);

class NativeAudioEngine extends WebAudioEngine {
  constructor(settings) {
    super(settings);
    this.helper = helperPath(); this.proc = null; this.closed = false; this.loadEpoch = 0; this.preloadEpoch = 0; this.seekEpoch = 0;
    this.decode = null; this.prepared = new WeakMap(); this.preloading = false; this.preloadTried = null; this.hardware = {}; this.mediaKeys = [];
    this.restarts = []; this.seeking = 0;
  }
  /** Where playback is meant to be: during a load that is the load's own position and play state. */
  get wantedPos() { return this.loading ? this.loadingPos : this.position; }
  get wantedPlay() { return this.loading ? this.loadingPlay : this.isPlaying; }
  get exclusiveWanted() { return this.s.outputMode === 'coreaudio-exclusive'; }
  /** The output the app wants; the helper resolves it (system output, fallback when the DAC is missing). */
  output() { return { device: this.s.deviceId || 'default', exclusive: this.exclusiveWanted, autoRate: this.s.autoSampleRate !== false }; }
  bindMediaKeys(on) {
    if (!globalShortcut) return;
    if (!on) { for (const key of this.mediaKeys) globalShortcut.unregister(key); this.mediaKeys = []; return; }
    if (this.mediaKeys.length) return;
    for (const [key, action] of [['MediaPlayPause', 'play'], ['MediaNextTrack', 'nexttrack'], ['MediaPreviousTrack', 'previoustrack']])
      if (globalShortcut.register(key, () => this.emit('media', { action }))) this.mediaKeys.push(key);
  }

  // ───────────── the helper process ─────────────
  start() {
    this.ready = new Promise(resolve => { this._hello = resolve; });
    if (!this.helper) { this._hello(); return; }
    const proc = this.proc = spawn(this.helper, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = this.lines = readline.createInterface({ input: proc.stdout });
    lines.on('line', line => {
      if (this.proc !== proc) return;
      let m; try { m = JSON.parse(line); } catch (e) { Log.error('Native audio message', e); return; }
      try { this.onMsg(m); } catch (e) { Log.error('Native audio event ' + m.e, e); }
    });
    proc.stdin.on('error', () => { });
    // the helper's own trace (commands, device events, watchdog) goes to miku.log
    let partial = '';
    proc.stderr.on('data', d => {
      const lines = (partial + String(d)).split('\n'); partial = lines.pop();
      for (const line of lines) if (line.trim()) Log.info('Core Audio: ' + line.slice(0, 2000));
    });
    const failed = e => {
      if (this.proc !== proc) return;
      this.proc = null; this._hello && this._hello(); lines.close();
      for (const done of this.waiters.values()) done({ ok: false, msg: '原生音訊核心已停止' });
      this.waiters.clear();
      this.onHelperExit(e);
    };
    proc.on('error', failed); proc.on('exit', (code, signal) => failed(new Error(`exit ${code}${signal ? ' ' + signal : ''}`)));
  }
  /** The helper owns nothing MIKU can't rebuild: start a new one and continue where playback was. */
  onHelperExit(e) {
    const track = this.track, wasLoaded = this.loaded || this.loading, playing = this.wantedPlay, pos = this.wantedPos;
    this.loading = false;
    ++this.loadEpoch; ++this.preloadEpoch; ++this.seekEpoch; this.preloadedFor = null; this.preloading = false;
    this.loaded = false; this.st.playing = false; this.signal = null; this.hardware = {};
    this.bindMediaKeys(false);
    if (this.closed) return;
    Log.error('Native audio helper stopped', e);
    if (track && wasLoaded) { this.pausedAt = pos; this.s.resumePosition = pos; }
    const now = Date.now();
    this.restarts = this.restarts.filter(t => now - t < 60000); this.restarts.push(now);
    this.emit('changed');
    if (this.restarts.length > 3) { this.emit('failed', '原生音訊核心多次異常結束；請重新開啟 MIKU'); return; }
    setTimeout(() => {
      if (this.closed) return;
      this.start();
      // the first restart in a minute resumes by itself; after that, wait for the user
      if (track && wasLoaded && playing && this.restarts.length === 1) this.load(track, pos, true);
      else if (track && wasLoaded) this.emit('failed', '原生音訊核心已重新啟動；按播放即可從原位置繼續');
    }, 300);
  }
  send(cmd) { if (this.proc && !this.proc.stdin.destroyed) this.proc.stdin.write(JSON.stringify(cmd) + '\n'); }
  /** Requests are logged when they time out or fail, so a stuck or failing output leaves a trace in miku.log. */
  async request(cmd, timeout) {
    const t0 = Date.now(), c = cmd.c, r = await super.request(cmd, timeout);
    if (!r) Log.info(`Core Audio ${c}: no answer after ${Date.now() - t0} ms`);
    else if (r.ok === false && !r.superseded) Log.info(`Core Audio ${c} failed: ${r.msg}`);
    return r;
  }
  emit(event, ...args) {
    if (event === 'failed') Log.info('Playback: ' + args[0]);
    return super.emit(event, ...args);
  }
  reply(m) {
    const done = m.seq && this.waiters.get(m.seq);
    if (!done) return false;
    this.waiters.delete(m.seq); done(m); return true;
  }
  setHardware(hw) {
    if (!hw) return;
    const before = this.hardware;
    this.hardware = hw; this.st.rate = hw.rate || this.st.rate;
    if (before.rate !== hw.rate || before.deviceUID !== hw.deviceUID || before.exclusive !== hw.exclusive) this.emit('devicechange');
  }
  onMsg(m) {
    switch (m.e) {
      case 'hello':
        if (m.version !== Protocol) Log.info(`Core Audio helper protocol ${m.version}, expected ${Protocol}`);
        this._hello && this._hello(); return;
      case 'loaded': if (m.ok && m.hardware) this.setHardware(m.hardware); this.reply(m); return;
      case 'probe': case 'stopped': case 'configured': case 'seeked': case 'resumed': case 'devices': this.reply(m); return;
      case 'error':
        if (this.reply(m)) return;
        if (m.fatal) { this.loaded = false; this.st.playing = false; this.signal = null; this.invalidateNext(); this.bindMediaKeys(false); this.emit('changed'); }
        if (m.msg) this.emit('failed', m.msg);
        return;
      // the end of a deck that a newer load is replacing (seek, track change) is not the end of the song
      case 'ended': if (this.loading) return; this.loaded = false; this.st.playing = false; this.emit('ended'); return;
      case 'status': this.onStatus(m); return;
      case 'started': this.onStarted(m); return;
      case 'output': this.onOutput(m); return;
      case 'lost': this.onLost(m); return;
      case 'devicechange': this.noteDeviceChange(); this.emit('devicechange'); return;
      case 'preloadFailed': this.preloadedFor = null; Log.info('Native preload: ' + m.msg); return;
      case 'restoreWarning': Log.info('Core Audio restore: ' + m.msg); return;
      // the helper can no longer run IO in its process and exits; a new one continues at the same place
      case 'restarting': Log.info('Core Audio helper restarting: ' + m.reason); return;
      case 'media': this.emit('media', m); return;
    }
  }
  /** A burst of device notifications (e.g. something keeps moving the system output) is worth a line in the log. */
  noteDeviceChange() {
    const now = Date.now();
    this.deviceChanges = (this.deviceChanges || []).filter(t => now - t < 3000); this.deviceChanges.push(now);
    if (this.deviceChanges.length === 15) Log.info('Core Audio: 15 device notifications within 3 s');
  }
  onStatus(m) {
    const before = JSON.stringify(this.signal), playing = this.st.playing;
    const { e, ...status } = m;
    // a seek / load in flight: its own position stands until the helper confirms it
    if (this.seeking || this.loading) delete status.pos;
    if (this.loading) delete status.playing;
    Object.assign(this.st, status); this.hardware = status; this.statusAt = Date.now();
    if (this.track && this.loaded) this.signal = this.buildSignal(this.track);
    if (before !== JSON.stringify(this.signal) || playing !== this.st.playing) this.emit('changed');
    this.maybePreload();
  }
  /** Gapless: the preloaded track took over inside the helper. */
  onStarted(m) {
    if (m.hardware) this.setHardware(m.hardware);
    if (this.preloadedFor && this.preloadedFor.id === m.id) this.decode = this.prepared.get(this.preloadedFor);
    this.preloadTried = null;
    this.onGapless(m.id);
  }
  /** The helper moved the output by itself: the system output changed, the selected DAC came back, the rate was changed elsewhere. */
  onOutput(m) {
    this.setHardware(m.hardware);
    if (this.loaded && typeof m.playing === 'boolean') this.st.playing = m.playing;
    if (Number.isFinite(m.pos)) { this.st.pos = m.pos; this.statusAt = Date.now(); }
    if (DropsPreload.has(m.reason)) { ++this.preloadEpoch; this.preloadedFor = null; this.preloadTried = null; this.preloading = false; }
    Log.info(`Core Audio output (${m.reason}): ${m.hardware && m.hardware.deviceName} ${m.hardware && m.hardware.rate} Hz`);
    this.refreshSignal(); this.emit('changed'); this.emit('devicechange');
  }
  /** The device went away, another app took it, or a move failed. The helper keeps the track paused at its place; Play continues there. */
  onLost(m) {
    const pos = Number.isFinite(m.pos) && m.pos >= 0 ? m.pos : this.position;
    ++this.preloadEpoch; this.preloadedFor = null; this.preloading = false; this.preloadTried = null;
    this.st.playing = false; this.st.pos = pos; this.statusAt = Date.now();
    this.hardware = { ...this.hardware, open: false, exclusive: false };
    if (this.track) this.s.resumePosition = pos;
    Log.info(`Core Audio output lost (${m.reason}): ${m.msg}`);
    this.refreshSignal(); this.emit('changed'); this.emit('devicechange');
    if (this.track) this.emit('failed', `${m.msg}${m.wasPlaying ? '，已暫停播放' : ''}。${m.reason === 'gone' ? '重新連接或選擇其他輸出後，' : ''}按播放即可從原位置繼續。`);
  }

  // ───────────── tracks ─────────────
  needsTranscode() { return false; }
  async prepare(t) {
    if (!ff.Ffmpeg.available) throw new Error('找不到 FFmpeg；請重新安裝 MIKU');
    const data = await ff.probe(t.path), stream = (data.streams || []).find(s => s.codec_type === 'audio');
    if (!stream) throw new Error('找不到音訊串流');
    const dsd = isDsd(t), rate = dsd ? (this.s.dsdPcmRate || 176400) : Number(stream.sample_rate);
    const bits = Number(stream.bits_per_raw_sample) || Number(stream.bits_per_sample) || t.bits || 0;
    const channels = Number(stream.channels) || t.channels || 2;
    if (!rate || !Number.isFinite(rate)) throw new Error('無法確認原始取樣率；已停止輸出');
    const integerSource = !dsd && /^(s16|s32|s64|u8)p?$/.test(stream.sample_fmt || '') && bits > 0 && bits <= 32;
    // more than two channels are mixed down to stereo by FFmpeg (labelled in the signal path)
    const prepared = { rate, bits, channels, dsd, integerSource, downmix: channels > 2, sampleFormat: stream.sample_fmt || '' };
    this.prepared.set(t, prepared); return prepared;
  }
  options(t, prepared) {
    return { ...prepared, ...this.output(), id: t.id, path: t.path, duration: t.duration || 0, ffmpeg: ff.Ffmpeg.path,
      dsp: this.s.dsp, gain: this.digitalGain(), rg: this.rgGain(t) };
  }
  async load(t, pos, play) {
    const epoch = ++this.loadEpoch; ++this.preloadEpoch; ++this.seekEpoch; await this.ready; if (epoch !== this.loadEpoch) return;
    const same = this.track && this.track.id === t.id;
    this.emit('loading', t); this.track = t; this.loaded = false;
    // A reload of the same track (seek, ReplayGain, recovery) keeps its signal badge instead of flashing 已停止.
    if (!same) this.signal = null;
    this.lastFailureWasDevice = false; this.loadFailed = false;
    this.loading = true; this.loadingPos = pos || 0; this.loadingPlay = !!play;
    // while it opens, the reported position is the one being loaded (not an old saved one)
    this.preloadedFor = null; this.preloadTried = null; this.pausedAt = pos || 0; this.preloading = false; this.emit('changed');
    try {
      if (!this.proc) { this.lastFailureWasDevice = true; throw new Error('原生 Core Audio 元件不可用；請重新安裝包含原生核心的 Mac 版'); }
      const prepared = await this.prepare(t); if (epoch !== this.loadEpoch) return;
      const r = await this.request({ c: 'load', ...this.options(t, prepared), pos: pos || 0, play: !!play }, 25000);
      if (epoch !== this.loadEpoch) return;
      this.loading = false;
      if (!r || !r.ok) {
        this.lastFailureWasDevice = !/FFmpeg|解碼/.test(r && r.msg || '');
        throw new Error(r && r.msg || '原生輸出逾時');
      }
      this.decode = prepared;
      this.loaded = true; this.pausedAt = null; this.st.pos = pos || 0; this.st.playing = !!r.playing; this.statusAt = Date.now();
      this.bindMediaKeys(true);
      this.signal = this.buildSignal(t); this.emit('changed');
    } catch (e) {
      if (epoch !== this.loadEpoch) return;
      // only a real failure counts (Player skips an unreadable file); a load replaced by a newer one is not one
      this.loading = false; this.loadFailed = true;
      this.send({ c: 'stop' }); this.loaded = false; this.st.playing = false; this.signal = null;
      // keep the place, so Play tries again from there (e.g. after the DAC is connected again)
      this.pausedAt = pos || 0; this.s.resumePosition = pos || 0;
      this.emit('failed', `無法播放「${t.title}」：${e.message}`); this.emit('changed');
    }
  }
  /** Same track, new place: the helper swaps decoders while the device keeps running. */
  async seek(pos) {
    const t = this.track; if (!t) return;
    pos = Math.max(0, pos || 0);
    if (!this.loaded || this.loading) return this.load(t, pos, this.wantedPlay);
    const epoch = ++this.seekEpoch, loadEpoch = this.loadEpoch, play = this.isPlaying;
    this.seeking++; this.st.pos = pos; this.statusAt = Date.now(); this.emit('changed');
    let r;
    try { r = await this.request({ c: 'seek', pos, play }, 12000); } finally { this.seeking--; }
    if (epoch !== this.seekEpoch || loadEpoch !== this.loadEpoch || !this.loaded) return;
    if (r && r.ok) { this.st.pos = Number.isFinite(r.pos) ? r.pos : pos; this.st.playing = !!r.playing; this.statusAt = Date.now(); this.emit('changed'); return; }
    if (r && r.superseded) return;
    Log.info('Native seek failed, reloading: ' + (r && r.msg));
    return this.load(t, pos, play);
  }
  async resume() {
    if (!this.loaded || !this.track) return;
    const epoch = this.loadEpoch;
    this.st.playing = true; this.statusAt = Date.now(); this.emit('changed');
    const r = await this.request({ c: 'resume' }, 15000);
    if (epoch !== this.loadEpoch || !this.loaded) return;
    if (r && r.ok) { this.setHardware(r.hardware); this.st.playing = !!r.playing; this.bindMediaKeys(true); }
    else { this.st.playing = !!(r && r.playing); if (r && r.hardware) this.setHardware(r.hardware); this.emit('failed', `無法繼續播放：${(r && r.msg) || '原生輸出逾時'}`); }
    this.refreshSignal(); this.emit('changed');
  }
  /** Output device, mode or rate matching changed: the helper moves the open track there, keeping its place and state. */
  async applyOutput() {
    if (!this.proc) { await this.ready; if (!this.proc) return; }
    const t = this.track;
    // a load still opening the old output: load again with the new one, at the place playback is meant to be
    if (t && this.loading) return this.load(t, this.wantedPos, this.wantedPlay);
    const cfg = { c: 'config', ...this.output() };
    if (!t || !this.loaded) { this.send(cfg); this.emit('changed'); return; }
    const epoch = this.loadEpoch, t0 = Date.now();
    Log.info(`Output switch → ${cfg.device} (${cfg.exclusive ? 'exclusive' : 'shared'})`);
    const r = await this.request(cfg, 25000);
    if (r && r.ok) Log.info(`Output switch done in ${Date.now() - t0} ms: ${r.hardware && r.hardware.deviceName} ${r.hardware && r.hardware.rate} Hz${r.playing ? ', playing' : ''}`);
    if (epoch !== this.loadEpoch || (r && r.superseded)) return;
    if (r && r.ok) {
      this.setHardware(r.hardware); this.st.playing = !!r.playing;
      if (Number.isFinite(r.pos)) { this.st.pos = r.pos; this.statusAt = Date.now(); }
      ++this.preloadEpoch; this.preloadedFor = null; this.preloadTried = null; this.preloading = false;
    } else {
      // the helper says what is open and playing after the failed switch (often nothing: paused at its place)
      this.st.playing = !!(r && r.playing);
      if (r && r.hardware) this.setHardware(r.hardware); else this.hardware = { ...this.hardware, open: false, exclusive: false };
      if (r && Number.isFinite(r.pos)) { this.st.pos = r.pos; this.statusAt = Date.now(); this.s.resumePosition = r.pos; }
      this.emit('failed', `無法切換輸出：${(r && r.msg) || '原生輸出逾時'}。${this.st.playing ? '' : '按播放會改用目前可用的輸出。'}`);
    }
    this.refreshSignal(); this.emit('changed'); this.emit('devicechange');
  }
  setDevice() { return this.applyOutput(); }
  async maybePreload() {
    if (!this.s.gapless || !this.isPlaying || !this.track || this.preloadedFor || this.preloading || this.seeking) return;
    const next = this.peekNext && this.peekNext(), dur = this.st.dur || this.track.duration || 0;
    if (!next || next === this.preloadTried || !dur || dur - this.st.pos > 30) return;
    // A different rate needs a DAC relock: Player.onEnded loads the next track at its own rate instead.
    const rate = isDsd(next) ? this.s.dsdPcmRate : next.sampleRate;
    if (this.s.autoSampleRate !== false && rate !== this.st.rate) return;
    const epoch = this.preloadEpoch; this.preloading = true; this.preloadTried = next;
    try {
      const prepared = await this.prepare(next);
      if (epoch !== this.preloadEpoch || !this.isPlaying || this.peekNext() !== next) return;
      if (this.s.autoSampleRate !== false && prepared.rate !== this.st.rate) return;
      this.preloadedFor = next; this.send({ c: 'preload', ...this.options(next, prepared), pos: 0 });
    } catch (e) { Log.error('Native preload', e); }
    finally { if (epoch === this.preloadEpoch) this.preloading = false; }
  }
  invalidateNext() {
    ++this.preloadEpoch; this.preloading = false; this.preloadedFor = null; this.preloadTried = null;
    this.send({ c: 'clearNext' });
  }
  stop() { ++this.loadEpoch; ++this.preloadEpoch; ++this.seekEpoch; this.loading = false; this.bindMediaKeys(false); super.stop(); }
  // ReplayGain belongs to the decoder: reload at the same place (same device and rate, so no relock and no gap)
  applyReplayGain() { this.invalidateNext(); if (this.track && (this.loaded || this.loading)) this.load(this.track, this.wantedPos, this.wantedPlay); }
  applyDsp() { this.send({ c: 'dsp', cfg: this.s.dsp }); this.refreshSignal(); this.emit('changed'); }
  applyVolume() { super.applyVolume(); this.emit('changed'); }
  refreshSignal() { if (this.track && this.loaded) this.signal = this.buildSignal(this.track); }
  dspSummary() {
    const summary = super.dspSummary(), dsp = this.s.dsp;
    const preamp = dsp.enabled && dsp.eqOn && !dsp.autoPreamp && Math.abs(dsp.preampDb || 0) > 1e-9 ? `前級增益 · ${dsp.preampDb} dB` : null;
    return [summary, preamp].filter(Boolean).join(' · ') || null;
  }
  async probeDevice(id) {
    await this.ready; if (!this.proc) return null;
    const r = await this.request({ c: 'probe', device: id || 'default' }, 5000); return r && r.caps;
  }
  async listDevices() { if (!this.proc) { await this.ready; if (!this.proc) return []; } return super.listDevices(); }
  deviceName() { return this.hardware.deviceName || super.deviceName(); }

  // ───────────── signal path ─────────────
  // Bit-perfect = exclusive (hog), device rate = source rate, a DAC format holding the source's bits (32-bit float
  // carries 16/24-bit integers exactly and the HAL converts them back exactly), unity gain, no DSP / ReplayGain /
  // downmix, integer PCM source, no buffer underrun.
  buildSignal(t) {
    const info = super.buildSignal(t, false), src = this.decode || {}, hw = this.hardware, dsd = isDsd(t);
    const exclusive = hw.exclusive === true, auto = this.s.autoSampleRate !== false, open = hw.open !== false && !!hw.rate;
    info.sourceRate = dsd ? t.sampleRate : (src.rate || t.sampleRate); info.sourceBits = dsd ? 1 : (src.bits || t.bits);
    info.sourceChannels = src.channels || t.channels || 2;
    info.outputRate = hw.rate || 0; info.outputFormat = hw.outputFormat || 'PCM'; info.outputBits = hw.outputBits || 0;
    info.physicalFormat = hw.physicalFormat; info.physicalBits = hw.physicalBits;
    info.exclusive = exclusive; info.mode = exclusive ? 'Core Audio 獨佔' : 'Core Audio 共享';
    info.device = hw.deviceName || this.deviceName(); info.decoder = 'FFmpeg · 原生 PCM';
    // DSD is converted directly at the output rate; PCM SRC happens in the FFmpeg decoder.
    info.resampled = open && !dsd && !!src.rate && src.rate !== hw.rate;
    info.resampler = 'FFmpeg'; if (dsd) info.dsdPcmRate = hw.rate;
    if (info.resampled || dsd) info.resamplerGainDb = -1;
    info.replayGainDb = null;
    if (Math.abs(hw.appliedReplayGainDb || 0) > 1e-9) info.replayGainDb = hw.appliedReplayGainDb;
    info.dspActive = !!this.s.dsp.enabled; info.dspSummary = this.dspSummary();
    const processing = dsd || !!this.s.dsp.enabled || info.replayGainDb != null || !!src.downmix || this.digitalGain() !== 1 ||
      hw.gainUnity !== true || hw.replayGainUnity !== true || hw.dspActive || info.resampled || !src.integerSource || (this.st.underruns || 0) > 0;
    const enoughBits = (hw.precisionBits || 0) >= (info.sourceBits || 99);
    const exact = open && exclusive && hw.exactPath === true && !processing && enoughBits;
    info.quality = info.lossy ? 'low' : processing ? 'enhanced' : exact ? 'bitperfect' : 'high';
    const notes = [];
    if (!open) notes.push('輸出裝置目前沒有開啟；按播放會從原位置繼續。');
    if (hw.fallbackDevice) notes.push('找不到選定的輸出裝置，暫時改用系統預設輸出；裝置接回後會自動切回。');
    if (hw.note) notes.push(hw.note + '。');
    if (dsd) notes.push('DSD 已轉成 PCM，無法標示原生 DSD bit-perfect。');
    else if (info.resampled) notes.push(!auto ? `已關閉自動匹配取樣率，${khz(src.rate)} kHz 會重新取樣到裝置目前的 ${khz(hw.rate)} kHz。`
      : `裝置不支援 ${khz(src.rate)} kHz，改為重新取樣到 ${khz(hw.rate)} kHz。`);
    else if (src.downmix) notes.push(`${info.sourceChannels} 聲道已混成雙聲道。`);
    else if (!src.integerSource && !info.lossy) notes.push('來源不是可直接保留的整數 PCM；目前會轉換樣本格式。');
    else if (open && !exclusive && !info.lossy) notes.push('共享模式經過 macOS 混音器，與其他程式的聲音一起輸出，無法保證 bit-perfect；改用獨佔模式可達到 bit-perfect。');
    else if (open && exclusive && hw.exactPath !== true && hw.hogHeld === false && !info.lossy)
      notes.push(hw.note ? '' : '開始播放時會取得 DAC 獨佔。');
    else if (open && exclusive && hw.exactPath !== true && !info.lossy)
      notes.push(hw.transport === 'bluetooth' ? '藍牙裝置會重新編碼，無法 bit-perfect。' : hw.transport === 'airplay' ? 'AirPlay 會重新編碼，無法 bit-perfect。'
        : hw.mono ? '這個裝置只有單聲道輸出，雙聲道會混合。' : '內建喇叭有系統音效處理，無法 bit-perfect；請使用耳機孔或外接 DAC。');
    else if (open && exclusive && !enoughBits && !info.lossy)
      notes.push(info.sourceBits > 24 ? `${info.sourceBits}-bit 整數來源超過 Core Audio 輸出路徑的 24-bit 精度。`
        : `DAC 目前的格式只有 ${hw.precisionBits}-bit，低於音樂的 ${info.sourceBits}-bit。`);
    if (exact && !info.lossy) notes.splice(0, notes.length, `已取得 DAC 獨佔，裝置取樣率與音樂相同（${khz(hw.rate)} kHz），DAC 格式 ${hw.physicalFormat || ''}；無 DSP、ReplayGain 或數位音量處理。此標示依輸出路徑判定，未逐樣本驗證 DAC 端資料。`);
    if ((this.st.underruns || 0) > 0) notes.push('原生輸出緩衝曾不足，已插入靜音；此曲無法確認完整 bit-perfect。');
    // macOS moves the system output off a hogged DAC: other apps' sound (and the system output setting) go elsewhere
    if (open && exclusive && hw.systemOutputName) notes.push(`獨佔期間 macOS 會把其他程式的聲音改從「${hw.systemOutputName}」播放；MIKU 仍輸出到「${info.device}」。`);
    info.note = notes.filter(Boolean).join(' ') || null;
    return info;
  }
  async dispose() {
    this.closed = true; this.bindMediaKeys(false); this.loaded = false; this.st.playing = false; const proc = this.proc; if (!proc) return;
    const exited = new Promise(resolve => proc.once('exit', resolve)); proc.stdin.end();
    const timer = setTimeout(() => proc.kill('SIGTERM'), 2000), forced = setTimeout(() => proc.kill('SIGKILL'), 5000);
    await exited; clearTimeout(timer); clearTimeout(forced); this.lines && this.lines.close();
  }
}
module.exports = { NativeAudioEngine, helperPath };

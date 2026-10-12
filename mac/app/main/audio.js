'use strict';
const { EventEmitter } = require('events');
const { WebAudioEngine } = require('./web-audio');
const { NativeAudioEngine, helperPath } = require('./native-audio');

// Keep Player and the UI attached to one stable facade when the output backend changes.
// Both output modes (shared and exclusive) use the native Core Audio helper; the browser engine is only the
// fallback for a build without the helper. An extension module may provide another playback core (設定 → 播放方案,
// extensions.js): coreFor(id) returns it, and the facade uses its engine while that core is chosen.
class AudioEngine extends EventEmitter {
  constructor(settings) { super(); this.s = settings; this.backend = null; this.peekNext = null; this.changeTask = Promise.resolve(); this.coreFor = null; this.coreId = 'miku'; }
  get nativeAvailable() { return !!helperPath(); }
  /** The core chosen in the settings when its module is there, else MIKU's own. */
  get wantedCore() { const id = this.s.audioCore || 'miku'; return id !== 'miku' && this.coreFor && this.coreFor(id) ? id : 'miku'; }
  create() {
    const core = this.wantedCore !== 'miku' ? this.coreFor(this.wantedCore) : null;
    let backend = null;
    if (core) {
      try { backend = core.createEngine(this.s); }
      catch (e) { require('./common').Log.error('Playback core ' + core.id, e); }
    }
    this.coreId = backend ? core.id : 'miku';
    if (!backend) backend = this.nativeAvailable ? new NativeAudioEngine(this.s) : new WebAudioEngine(this.s);
    this.backend = backend;
    backend.peekNext = () => this.peekNext && this.peekNext();
    for (const event of ['changed', 'loading', 'failed', 'media', 'devicechange', 'trackStarted', 'ended'])
      backend.on(event, (...args) => { if (this.backend === backend) this.emit(event, ...args); });
    backend.start();
  }
  start() { this.create(); }
  /** Output mode or rate matching changed. The native helper moves the open track itself (same place, same state). */
  reconfigure() {
    this.changeTask = this.changeTask.catch(() => { }).then(async () => {
      const old = this.backend, track = old.track, pos = old.position, play = old.isPlaying;
      if (this.coreId !== this.wantedCore || (this.coreId === 'miku' && (old instanceof NativeAudioEngine) !== this.nativeAvailable)) {
        this.backend = null;
        if (old.dispose) await old.dispose();
        else { old.stop(); if (old.win && !old.win.isDestroyed()) old.win.destroy(); }
        this.create();
        if (track) await this.backend.load(track, pos, play);
        else this.emit('changed');
      } else if (old.applyOutput) await old.applyOutput();
      else if (track) await old.load(track, pos, play);
      else this.emit('changed');
    });
    return this.changeTask;
  }
  get isPlaying() { return !!this.backend?.isPlaying; }
  get isLoaded() { return !!this.backend?.isLoaded; }
  get position() { return this.backend?.position || 0; }
  get st() { return this.backend?.st || {}; }
  get track() { return this.backend?.track || null; }
  get signal() { return this.backend?.signal || null; }
  get lastFailureWasDevice() { return !!this.backend?.lastFailureWasDevice; }
  /** The last load really failed (not replaced by a newer load, e.g. during an output switch). */
  get loadFailed() { return !!this.backend?.loadFailed; }
  get pausedAt() { return this.backend?.pausedAt; }
  set pausedAt(v) { if (this.backend) this.backend.pausedAt = v; }
  deviceName() { return this.backend?.deviceName() || '系統預設輸出'; }
  meter() { return this.backend?.meter() || { l: 0, r: 0, clips: 0, underruns: 0 }; }
  load(...a) { return this.changeTask.then(() => this.backend.load(...a)); }
  pause() { this.backend?.pause(); }
  resume() { return this.backend?.resume(); }
  seek(...a) { return this.backend?.seek(...a); }
  stop() { this.backend?.stop(); }
  invalidateNext() { this.backend?.invalidateNext(); }
  applyVolume() { this.backend?.applyVolume(); }
  applyDsp() { this.backend?.applyDsp(); }
  applyReplayGain() { this.backend?.applyReplayGain(); }
  setDevice(...a) { return this.changeTask.then(() => this.backend ? this.backend.setDevice(...a) : undefined); }
  listDevices() { return this.backend ? this.backend.listDevices() : Promise.resolve([]); }
  probeDevice(...a) { return this.backend?.probeDevice ? this.backend.probeDevice(...a) : Promise.resolve(null); }
  /** Exclusive mode with the device in use: only the engine can make a sound on it (see main.js overlay.play). */
  overlayReady() { return this.s.outputMode === 'coreaudio-exclusive' && !!this.backend?.overlayReady?.(); }
  playOverlay(cue) { if (!this.overlayReady()) return false; this.backend.playOverlay(cue); return true; }
  async dispose() {
    if (this.backend?.dispose) await this.backend.dispose();
    else this.backend?.stop();
  }
}
module.exports = { AudioEngine };

'use strict';
// Main-process side of the audio engine: drives the hidden engine window and mirrors its state
// with the same surface the Windows AudioEngine had (load / pause / seek / signal / meter / events).
const path = require('path');
const { EventEmitter } = require('events');
const { BrowserWindow, ipcMain } = require('electron');
const { Log } = require('./common');
const { isDsd, isLossy } = require('./library');
const ff = require('./ffmpeg');

// what Chromium decodes natively; everything else goes through FFmpeg first
const NativeExt = new Set(['.mp3', '.m4a', '.aac', '.mp4', '.flac', '.wav', '.ogg', '.oga', '.opus']);
const ext = p => path.extname(p || '').toLowerCase();

class AudioEngine extends EventEmitter {
  constructor(settings) {
    super();
    this.s = settings;
    this.win = null;
    this.seq = 0;
    this.waiters = new Map();
    this.st = { id: null, pos: 0, playing: false, l: 0, r: 0, clips: 0, underruns: 0, rate: 0 };
    this.statusAt = 0;
    this.track = null;
    this.loaded = false;
    this.signal = null;
    this.lastFailureWasDevice = false;
    this.nativeFailed = new Set();
    this.devices = [];
    this.peekNext = null;
    this.preloadedFor = null;
    this.pausedAt = null;
  }

  start() {
    this.win = new BrowserWindow({
      show: false, width: 200, height: 100,
      webPreferences: { preload: path.join(__dirname, 'engine-preload.js'), backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', contextIsolation: true, sandbox: true },
    });
    ipcMain.on('eng', (e, m) => { if (this.win && e.sender === this.win.webContents) this.onMsg(m); });
    this.win.loadURL('miku://engine/engine.html');
    this.win.webContents.on('render-process-gone', (_e, d) => { Log.info('Engine renderer gone: ' + d.reason); this.loaded = false; this.emit('changed'); setTimeout(() => { if (this.win && !this.win.isDestroyed()) this.win.reload(); }, 500); });
    this.ready = new Promise(r => (this._hello = r));
  }
  send(cmd) { if (this.win && !this.win.isDestroyed()) this.win.webContents.send('eng', cmd); }
  request(cmd, timeout = 10000) {
    const seq = ++this.seq;
    cmd.seq = seq;
    return new Promise(resolve => {
      const t = setTimeout(() => { this.waiters.delete(seq); resolve(null); }, timeout);
      this.waiters.set(seq, m => { clearTimeout(t); resolve(m); });
      this.send(cmd);
    });
  }

  onMsg(m) {
    switch (m.e) {
      case 'hello':
        this._hello && this._hello();
        this.send({ c: 'init' });
        this.send({ c: 'dsp', cfg: this.s.dsp });
        this.send({ c: 'gain', v: this.digitalGain(), instant: true });
        if (this.s.deviceId) this.send({ c: 'sink', id: this.s.deviceId, seq: 0 });
        break;
      case 'rate': this.st.rate = m.rate; break;
      case 'status': {
        const wasPlaying = this.st.playing;
        Object.assign(this.st, m); this.statusAt = Date.now();
        if (wasPlaying !== m.playing) this.emit('changed');
        this.maybePreload();
        break;
      }
      case 'loaded': case 'devices': case 'sinkDone': {
        const w = this.waiters.get(m.seq);
        if (w) { this.waiters.delete(m.seq); w(m); }
        break;
      }
      case 'started': this.onGapless(m.id); break;
      case 'ended': this.loaded = false; this.emit('ended'); break;
      case 'error': if (m.msg) this.emit('failed', m.msg); break;
      case 'media': this.emit('media', m); break;
      case 'devicechange': this.emit('devicechange'); break;
    }
  }

  // ───────────── state ─────────────
  get isPlaying() { return this.loaded && this.st.playing; }
  get isLoaded() { return this.loaded; }
  get position() {
    if (!this.loaded) return this.pausedAt ?? this.s.resumePosition ?? 0;
    let p = this.st.pos || 0;
    if (this.st.playing && this.statusAt) p += Math.min(0.25, (Date.now() - this.statusAt) / 1000);
    return p;
  }
  meter() { return this.loaded ? { l: this.st.l, r: this.st.r, clips: this.st.clips, underruns: this.st.underruns } : { l: 0, r: 0, clips: 0, underruns: 0 }; }

  needsTranscode(t) { return isDsd(t) || !NativeExt.has(ext(t.path)) || this.nativeFailed.has(t.id); }
  url(t, transcode) { return `miku-media://media/play/${encodeURIComponent(t.id)}${transcode ? '?tx=1' : ''}`; }
  rgGain(t) {
    if (this.s.replayGain === 'off') return 1;
    const rg = this.s.replayGain === 'album' ? (t.rgAlbum ?? t.rgTrack) : (t.rgTrack ?? t.rgAlbum);
    if (rg == null) return 1;
    return Math.pow(10, (rg + (this.s.replayGainPreamp || 0)) / 20);
  }
  metaOf(t) { return { title: t.title, artist: t.artist, album: t.album }; }

  async load(t, pos, play) {
    await this.ready;
    this.emit('loading', t);
    this.track = t; this.loaded = false; this.signal = null; this.pausedAt = null; this.preloadedFor = null;
    this.lastFailureWasDevice = false;
    this.emit('changed');
    let tx = this.needsTranscode(t);
    let r = await this.request({ c: 'load', id: t.id, url: this.url(t, tx), pos: pos || 0, play, rg: this.rgGain(t), meta: this.metaOf(t), timeout: tx ? 300000 : 30000 }, tx ? 310000 : 40000);
    if (this.track !== t) return;
    if (r && !r.ok && !tx && (r.code === 3 || r.code === 4) && ff.Ffmpeg.available) {
      // Chromium can't decode this file (e.g. ALAC, odd WAV): decode it with FFmpeg instead
      Log.info(`Native decode failed for ${t.path} (${r.code}), using FFmpeg`);
      this.nativeFailed.add(t.id); tx = true;
      r = await this.request({ c: 'load', id: t.id, url: this.url(t, true), pos: pos || 0, play, rg: this.rgGain(t), meta: this.metaOf(t), timeout: 300000 }, 310000);
      if (this.track !== t) return;
    }
    if (!r || !r.ok) {
      this.loaded = false;
      const msg = (r && r.msg) || '播放逾時';
      this.emit('failed', `無法播放「${t.title}」：${msg}`);
      this.emit('changed');
      return;
    }
    this.loaded = true;
    this.st.pos = pos || 0; this.st.playing = !!play; this.statusAt = Date.now();
    this.signal = this.buildSignal(t, tx);
    this.emit('changed');
  }

  onGapless(id) {
    const next = this.preloadedFor && this.preloadedFor.id === id ? this.preloadedFor : null;
    this.preloadedFor = null;
    if (!next) return;
    this.track = next; this.loaded = true;
    this.st.pos = 0; this.statusAt = Date.now();
    this.signal = this.buildSignal(next, this.needsTranscode(next));
    this.emit('trackStarted', next);
    this.emit('changed');
  }

  maybePreload() {
    if (!this.s.gapless || !this.loaded || !this.track || this.preloadedFor) return;
    const next = this.peekNext && this.peekNext();
    if (!next) return;
    // formats that need FFmpeg are decoded ahead of time so the switch stays seamless
    if (this.needsTranscode(next) && this.txKicked !== next.id) { this.txKicked = next.id; ff.transcode(next, this.s.dsdPcmRate || 176400).catch(() => { }); }
    const dur = this.st.dur || this.track.duration || 0;
    if (!dur || dur - this.st.pos > 30) return;
    this.preloadedFor = next;
    const tx = this.needsTranscode(next);
    this.send({ c: 'preload', id: next.id, url: this.url(next, tx), rg: this.rgGain(next), meta: this.metaOf(next) });
  }
  invalidateNext() { if (this.preloadedFor) { this.preloadedFor = null; this.send({ c: 'clearNext' }); } }

  pause() { if (!this.loaded) return; this.send({ c: 'pause' }); this.st.playing = false; this.emit('changed'); }
  resume() { if (!this.loaded) return; this.send({ c: 'resume' }); this.st.playing = true; this.statusAt = Date.now(); this.emit('changed'); }
  async seek(pos) { if (!this.loaded) return; this.send({ c: 'seek', pos }); this.st.pos = pos; this.statusAt = Date.now(); this.emit('changed'); }
  stop() { this.pausedAt = this.loaded ? this.position : null; this.send({ c: 'stop' }); this.loaded = false; this.track = null; this.signal = null; this.preloadedFor = null; this.emit('changed'); }

  digitalGain() {
    if (this.s.volumeMode !== 'digital') return this.s.muted ? 0 : 1;
    if (this.s.muted) return 0;
    return Math.pow(10, Math.min(0, Math.max(-100, this.s.volumeDb)) / 20);
  }
  applyVolume() { this.send({ c: 'gain', v: this.digitalGain() }); this.refreshSignal(); }
  applyDsp() {
    this.send({ c: 'dsp', cfg: this.s.dsp });
    if (this.signal) { this.signal.dspActive = !!this.s.dsp.enabled; this.signal.dspSummary = this.dspSummary(); this.signal.quality = this.quality(this.signal); }
    this.emit('changed');
  }
  applyReplayGain() { if (this.track && this.loaded) this.send({ c: 'rg', v: this.rgGain(this.track) }); if (this.track && this.signal) this.signal = this.buildSignal(this.track, this.needsTranscode(this.track)); }
  async setDevice(id) { await this.request({ c: 'sink', id: id || '' }, 8000); if (this.signal) this.signal.device = this.deviceName(); }

  async listDevices() {
    await this.ready;
    const r = await this.request({ c: 'devices' }, 5000);
    this.devices = (r && r.list) || this.devices;
    return this.devices;
  }
  deviceName() {
    const d = this.devices.find(x => x.id === this.s.deviceId) || this.devices.find(x => x.isDefault);
    return d ? d.name : '系統預設輸出';
  }

  dspSummary() {
    const d = this.s.dsp;
    if (!d.enabled) return null;
    const parts = [];
    const n = d.eqOn ? (d.bands || []).filter(b => b.on && !(Math.abs(b.gain) < 1e-6 && !['LP', 'LPQ', 'HP', 'HPQ'].includes((b.type || 'PK').toUpperCase()))).length : 0;
    if (n > 0) parts.push(d.presetName ? `EQ · ${d.presetName}` : `參數 EQ · ${n} 段`);
    if (d.crossfeed && d.crossfeed.on) parts.push('Crossfeed');
    if (Math.abs(d.balance || 0) > 0.001) parts.push('平衡');
    if (d.invert) parts.push('反相');
    return parts.length ? parts.join(' · ') : null;
  }

  buildSignal(t, transcoded) {
    const dsd = isDsd(t);
    const outRate = this.st.rate || 48000;
    const srcRate = t.sampleRate || 0;
    const decodedRate = dsd ? (this.s.dsdPcmRate || 176400) : srcRate;
    const info = {
      codec: t.codec, sourceRate: srcRate, sourceBits: dsd ? 1 : t.bits, dsd, dsdLabel: dsd && srcRate ? 'DSD' + Math.round(srcRate / 44100) : null,
      lossy: isLossy(t), dop: false, resampled: dsd ? true : (decodedRate && decodedRate !== outRate),
      outputRate: outRate, outputFormat: '32-bit 浮點', outputBits: 32, mode: 'Core Audio', device: this.deviceName(),
      dspActive: !!this.s.dsp.enabled, dspSummary: this.dspSummary(), volumeMode: this.s.volumeMode === 'hardware' ? 'digital' : this.s.volumeMode,
      replayGainDb: null, note: null,
    };
    if (this.s.replayGain !== 'off') {
      const rg = this.s.replayGain === 'album' ? (t.rgAlbum ?? t.rgTrack) : (t.rgTrack ?? t.rgAlbum);
      if (rg != null) info.replayGainDb = rg + (this.s.replayGainPreamp || 0);
    }
    if (!dsd && decodedRate && decodedRate !== outRate)
      info.note = `輸出裝置目前是 ${(outRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz，與音樂的 ${(decodedRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz 不同，會重新取樣。可在「音訊 MIDI 設定」把 DAC 的格式改成相同取樣率。`;
    else if (transcoded && !dsd) info.note = '這個格式由 FFmpeg 無損解碼後播放。';
    info.quality = this.quality(info);
    return info;
  }
  quality(i) {
    if (i.lossy) return 'low';
    const volumeTouches = i.volumeMode === 'digital' && Math.abs(this.s.volumeDb) > 1e-9;
    if ((i.dspActive && i.dspSummary) || i.replayGainDb != null || i.resampled || volumeTouches) return 'enhanced';
    return 'high';
  }
  refreshSignal() { if (this.signal) { this.signal.volumeMode = this.s.volumeMode === 'hardware' ? 'digital' : this.s.volumeMode; this.signal.quality = this.quality(this.signal); } }
}

module.exports = { AudioEngine };

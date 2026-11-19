'use strict';
// A stand-in for the MIKU host (windows/Host/MainForm.cs, mac/app/main): it answers the page's RPCs and posts the same
// events at the same pace (state 5×/s while playing, once a second while paused, changes after 30 ms). It runs in the
// test's Node process, outside the page, as the real host does: nothing it does counts as the page's own work.
const { makeLyrics } = require('./library.cjs');

class FakeHost {
  /**
   * lib: makeLibrary()'s result; post(msg): delivers a message to the page; opts.lyrics: 'line' | 'word' | 'plain' |
   * 'none' | (trackId => mode); opts.signal: 'hires' | 'cd' | 'dsd' | 'lossy' | 'dsp' | 'upsample' | 'shared'.
   */
  constructor(lib, post, opts = {}) {
    this.lib = lib; this.post = post; this.opts = opts;
    this.tracks = new Map(lib.tracks.map(t => [t[0], t]));
    const ids = lib.tracks.map(t => t[0]);
    this.settings = {
      folders: ['D:\\MUSIC'], watchFolders: true, audioCore: 'miku', outputMode: 'exclusive', deviceId: 'dev0', bufferMs: 100, upsampling: 'off',
      gapless: true, replayGain: 'off', volumeDb: -12, muted: false, volumeMode: 'digital', repeat: 'off', shuffle: false, onlineArt: false, onlineLyrics: true,
      autoContinue: 'off', remoteEnabled: false, remotePort: 8765, autoUpdate: false,
      favorites: ids.filter((_, i) => i % 37 === 0).slice(0, 40), recent: ids.filter((_, i) => i % 11 === 0).slice(0, 60),
      searchHistory: ['miku', 'blue'], ui: { theme: 'miku', lang: 'zh-Hant', ...(opts.ui || {}) },
      dsp: { enabled: false, eqOn: true, preampDb: 0, autoPreamp: true, bands: [], presetName: '', crossfeed: { on: false, fc: 700, feed: 4.5 }, balance: 0, invert: false }, presets: [],
      ...(opts.settings || {}),
    };
    this.queue = { ids: ids.slice(0, 40), index: 0 };
    this.playing = false; this.pos = 0; this.at = Date.now();
    this.unknown = new Map(); this.calls = new Map();
    this.tick = null; this.closed = false; this.visible = true;
  }

  /* ── player ── */
  track() { return this.tracks.get(this.queue.ids[this.queue.index]); }
  position() {
    const t = this.track(), dur = t ? t[6] : 0;
    return Math.min(dur, this.pos + (this.playing ? (Date.now() - this.at) / 1000 : 0));
  }
  signal() {
    const t = this.track();
    if (!t || !this.loaded) return null;
    const kind = this.opts.signal || (t[7] === 'DSF' ? 'dsd' : t[7] === 'MP3' ? 'lossy' : t[9] > 16 ? 'hires' : 'cd');
    const base = { codec: t[7], sourceBits: t[9], sourceRate: t[8], outputRate: t[8], outputFormat: '24-bit', mode: 'WASAPI 獨佔', device: 'Test DAC',
      quality: 'bitperfect', dspActive: false, dsd: false, resampled: false, volumeMode: 'fixed', decoder: 'FFmpeg', eventDriven: true };
    if (kind === 'hires') return { ...base, codec: 'FLAC', sourceBits: 24, sourceRate: 96000, outputRate: 96000 };
    if (kind === 'cd') return { ...base, codec: 'FLAC', sourceBits: 16, sourceRate: 44100, outputRate: 44100 };
    if (kind === 'dsd') return { ...base, codec: 'DSF', dsd: true, dsdLabel: 'DSD64', sourceBits: 1, sourceRate: 2822400, outputRate: 2822400, dsdDirect: true };
    if (kind === 'lossy') return { ...base, codec: 'MP3', sourceBits: 0, sourceRate: 44100, outputRate: 44100, quality: 'low', lossy: true };
    if (kind === 'dsp') return { ...base, quality: 'enhanced', dspActive: true, dspSummary: 'EQ · Crossfeed' };
    if (kind === 'upsample') return { ...base, codec: 'FLAC', sourceBits: 16, sourceRate: 44100, outputRate: 176400, quality: 'enhanced', resampled: true, resampler: 'SoX VHQ' };
    return { ...base, quality: 'high', mode: 'WASAPI 共享' };
  }
  state() {
    const t = this.track(), s = this.settings;
    return {
      trackId: t ? t[0] : null, playing: this.playing, loaded: !!this.loaded, pos: +this.position().toFixed(3), dur: t ? t[6] : 0, index: this.queue.index,
      volumeDb: s.volumeDb, muted: s.muted, volumeMode: s.volumeMode, repeat: s.repeat, shuffle: s.shuffle, signal: this.signal(),
      meter: { l: this.playing ? +(Math.random() * .8).toFixed(4) : 0, r: this.playing ? +(Math.random() * .8).toFixed(4) : 0, clips: 0, underruns: 0, resampleOverloads: 0, resamplePeak: null, resampleMeterAvailable: false },
    };
  }
  queueDto() { return { ids: this.queue.ids, index: this.queue.index, shuffle: this.settings.shuffle, repeat: this.settings.repeat, source: this.queue.source || null, continued: null }; }
  soon(what) {
    if (this._soon && this._soon.has(what)) return;
    (this._soon = this._soon || new Set()).add(what);
    setTimeout(() => { this._soon.delete(what); if (!this.closed) this.post({ ev: what, d: what === 'state' ? this.state() : this.queueDto() }); }, 30);
  }
  startTick() {
    clearInterval(this.tick);
    let n = 0;
    this.tick = setInterval(() => {
      if (this.closed) return;
      // the end of a track: the next one starts by itself
      const t = this.track();
      if (this.playing && t && this.position() >= t[6] - 0.05) { this.jump(this.queue.index + 1 < this.queue.ids.length ? this.queue.index + 1 : 0); return; }
      n++;
      if (!this.visible) return;                      // minimized: the host posts nothing
      if (this.playing || n % 5 === 0) this.post({ ev: 'state', d: this.state() });
    }, 200);
  }
  jump(i, at = 0) {
    this.queue.index = Math.max(0, Math.min(this.queue.ids.length - 1, i));
    this.pos = at; this.at = Date.now(); this.playing = true; this.loaded = true;
    this.soon('state'); this.soon('queue');
  }
  pause(on) { this.pos = this.position(); this.at = Date.now(); this.playing = !on; this.soon('state'); }

  /* ── RPC ── */
  async handle(m, a = {}) {
    this.calls.set(m, (this.calls.get(m) || 0) + 1);
    const s = this.settings;
    switch (m) {
      case 'ready': this.startTick(); return this.init();
      case 'init': return this.init();
      case 'state': return this.state();
      case 'queue': return this.queueDto();
      case 'play': {
        let ids = (a.ids || []).filter(id => this.tracks.has(id));
        if (!ids.length) return null;
        if (a.shuffle !== undefined) s.shuffle = !!a.shuffle;
        this.queue = { ids, index: 0, source: a.source || null };
        this.jump(Math.max(0, a.start || 0), a.at || 0);
        return null;
      }
      case 'toggle': this.loaded = true; this.pause(this.playing); return null;
      case 'next': this.jump(this.queue.index + 1 < this.queue.ids.length ? this.queue.index + 1 : 0); return null;
      case 'prev': this.jump(Math.max(0, this.queue.index - 1)); return null;
      case 'seek': this.pos = Math.max(0, +a.pos || 0); this.at = Date.now(); this.soon('state'); return null;
      case 'volume': s.volumeDb = a.db; s.muted = !!a.muted; this.soon('state'); return null;
      case 'shuffle': s.shuffle = !!a.on; this.soon('state'); this.soon('queue'); return null;
      case 'repeat': s.repeat = a.mode; this.soon('state'); this.soon('queue'); return null;
      case 'queue.add': { const at = a.next ? this.queue.index + 1 : this.queue.ids.length; this.queue.ids.splice(at, 0, ...(a.ids || [])); this.soon('queue'); return null; }
      case 'queue.remove': this.queue.ids.splice(a.i, 1); if (a.i < this.queue.index) this.queue.index--; this.soon('queue'); return null;
      case 'queue.jump': this.jump(a.i); return null;
      case 'queue.move': { const [x] = this.queue.ids.splice(a.from, 1); this.queue.ids.splice(a.to, 0, x); this.soon('queue'); return null; }
      case 'queue.clear': this.queue.ids.length = this.queue.index + 1; this.soon('queue'); return null;
      case 'fav': { const f = new Set(s.favorites); a.on ? f.add(a.id) : f.delete(a.id); s.favorites = [...f]; return null; }
      case 'recent.add': s.recent = [a.id, ...s.recent.filter(x => x !== a.id)].slice(0, 200); return null;
      case 'recent.clear': s.recent = []; return null;
      case 'search.add': case 'search.remove': case 'search.clear': return null;
      case 'ui': s.ui[a.key] = a.value; return null;
      case 'settings': Object.assign(s, a || {}); this.soon('state'); return s;
      case 'stop': this.playing = false; this.loaded = false; this.pos = 0; this.soon('state'); return null;
      case 'lyrics': {
        const t = this.tracks.get(a.id);
        if (!t) return null;
        const mode = typeof this.opts.lyrics === 'function' ? this.opts.lyrics(a.id) : this.opts.lyrics || 'line';
        await new Promise(r => setTimeout(r, 40));   // a disk / network lookup
        return makeLyrics(a.id, t[6], mode);
      }
      case 'lyrics.candidates': return [];
      case 'lyricsOffset': return null;
      case 'track': { const t = this.tracks.get(a.id); return t ? { id: t[0], title: t[1], artist: t[2] } : null; }
      case 'devices': return { devices: [{ id: 'dev0', name: 'Speakers (Test DAC)', isDefault: true, exclusive: true }, { id: 'dev1', name: 'Headphones', isDefault: false, exclusive: false }],
        caps: { id: 'dev0', name: 'Speakers (Test DAC)', mixRate: 48000, mixChannels: 2, hardwareVolume: false, summary: '44.1–384 kHz · 32-bit', rates: [44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000], formats: { 44100: ['32-bit', '24-bit', '16-bit'], 96000: ['32-bit', '24-bit'] } }, asio: [] };
      case 'probe': return null;
      case 'asio.rates': return [44100, 48000, 96000];
      case 'art.info': return { source: 'embedded', confirmed: true };
      case 'cd.info': return { disc: null, ripping: false };
      case 'suggestFolders': return [];
      case 'update.info': case 'update.check': return { version: '0.0.0-test', latest: '0.0.0-test', newer: false, missing: false, ready: false, busy: false, progress: 0, error: null, checkedAt: Date.now(), restart: false, extensions: [] };
      case 'remote.info': return { enabled: false, port: 8765, running: false, error: null, urls: [], devices: [], code: null };
      case 'remoteLib.info': return { paired: false, pairing: null, active: false, online: false, error: null, only: '', remotes: [], albums: 0, tracks: 0, quality: 'orig', cacheGB: 5, cacheBytes: 0, offlineBytes: 0, offlineDir: 'D:\\MIKU-offline', offlineCustom: false, moving: false, offline: [], loading: null };
      case 'convert.info': return { ffmpeg: true, formats: [] };
      case 'acoustid.info': return { hasKey: false };
      case 'overlay.can': return false;
      case 'presets': case 'dsp': case 'rescan': return null;
      case 'cue.info': return null;
      case 'fullscreen': this.post({ ev: 'fullscreen', d: { on: !!a.on } }); return null;
      case 'ui.visibility': return null;
      case 'yt.show': case 'yt.hide': case 'yt.nav': case 'devtools': case 'reveal': return null;
      case 'ext.list': return [];
    }
    if (this.opts.rpc) { const r = await this.opts.rpc(m, a, this); if (r !== undefined) return r; }
    this.unknown.set(m, (this.unknown.get(m) || 0) + 1);
    return null;
  }
  init() {
    return { settings: this.settings, version: '0.0.0-test', installLang: 'zh-Hant', sysLang: 'zh-TW', ffmpeg: true, platform: this.opts.platform === 'mac' ? 'mac' : 'windows',
      cores: [{ id: 'miku', name: 'FFmpeg', dsdPcmRate: true }], asio: [], scan: { scanning: false, done: 0, found: 0 }, state: this.state(), queue: this.queueDto(),
      extensions: this.opts.extensions || [], loudness: null, continuation: null };
  }
  /** One message from the page: { id, m, a }. */
  async onMessage(raw) {
    let msg; try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
    if (!msg || typeof msg.m !== 'string') return;
    let r = null, e = null;
    try { r = await this.handle(msg.m, msg.a || {}); } catch (err) { e = String(err && err.message || err); }
    if (msg.id && !this.closed) this.post({ id: msg.id, r, e });
  }
  close() { this.closed = true; clearInterval(this.tick); }
}
module.exports = { FakeHost };

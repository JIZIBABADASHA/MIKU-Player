'use strict';
// The volume of the device MIKU holds in exclusive mode (hog mode). Core Audio refuses volume changes on it from every
// other process and macOS moves the system output elsewhere, so the volume keys and the Sound menu change the speakers
// and the headphones can't be turned down or up. Only the process that holds the device can change its volume: the
// playback core does it here (engine.deviceVolume), on the hardware, so the samples stay as they are (bit-perfect).
//
//   MIKU's own slider   with 固定 0 dB it stands for the device's hardware volume while the device is held
//   the volume keys     "MIKU Volume Keys" (native/volumekeys.m) takes them while the device is held; needs the
//                       Accessibility permission, asked for once; an indicator (osd.js) shows the level
// A device without a volume of its own: the keys move MIKU's digital volume when that is chosen, else stay macOS's.
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const { Log, AppPaths } = require('./common');

class DeviceVolume extends EventEmitter {
  /** opts: enabled() the keys are wanted; digital() / setDigital(step, mute): MIKU's own digital volume, for a device without one. */
  constructor(engine, opts) {
    super();
    this.engine = engine; this.opts = opts;
    this.state = null;      // { scalar, db, min_db, max_db, muted, can_mute } of the held device
    this.held = false; this.chain = Promise.resolve(); this.timer = null;
    this.keys = new VolumeKeys(k => this.onKey(k), () => this.emit('keys'));
    engine.on('changed', () => this.refreshSoon());
    engine.on('devicechange', () => this.refreshSoon());
  }
  get trusted() { return this.keys.trusted; }
  refreshSoon() { if (this.timer) return; this.timer = setTimeout(() => { this.timer = null; this.refresh(); }, 250); }
  refresh() { return this.apply({}); }
  /** Reads the volume, after setting what `change` says ({ scalar | db, muted }); one at a time. */
  apply(change) {
    const run = async () => {
      const before = JSON.stringify(this.state);
      const c = typeof change === 'function' ? change(this.state) : change;
      this.held = !!this.engine.holdsDevice;
      let v = null;
      if (this.held && c) { try { v = await this.engine.deviceVolume(c); } catch (e) { Log.error('Device volume', e); } }
      else if (this.held) v = this.state;
      this.state = v;
      this.syncKeys();
      if (JSON.stringify(v) !== before) this.emit('changed');
      return v;
    };
    return (this.chain = this.chain.then(run, run));
  }
  /** Whether the keys are MIKU's now. */
  get keysApply() { return this.held && this.opts.enabled() && (!!this.state || this.opts.digital()); }
  syncKeys() { this.keys.want(this.keysApply); }
  async onKey({ key, fine }) {
    if (!this.held) return;
    if (!this.state) { if (this.opts.digital()) this.opts.setDigital(key === 'up' ? (fine ? 0.5 : 2) : key === 'down' ? (fine ? -0.5 : -2) : 0, key === 'mute'); return; }
    await this.refresh();   // the headphones' own buttons may have moved it
    const v = await this.apply(s => s && (key === 'mute' ? this.muteChange(s, !s.muted) : this.stepChange(s, key === 'up' ? 1 : -1, fine ? 64 : 16)));
    if (v) this.emit('osd', v);
  }
  /** One step of macOS's own: 1/16 (with Option-Shift 1/64), on that grid. */
  stepChange(s, dir, n) {
    const at = s.scalar * n;
    const next = dir > 0 ? Math.floor(at + 1e-3) + 1 : Math.ceil(at - 1e-3) - 1;
    return { scalar: Math.max(0, Math.min(1, next / n)), ...(s.can_mute && s.muted ? { muted: false } : {}) };
  }
  muteChange(s, on) {
    if (s.can_mute) return { muted: on };
    if (s.scalar > 0) { this.unmuteTo = s.scalar; return { scalar: 0 }; }
    return { scalar: this.unmuteTo || 1 / 16 };
  }
  /** MIKU's slider: a level in dB, muted or not. */
  set(db, muted) {
    return this.apply(s => {
      if (!s) return null;
      const back = !s.can_mute && muted === false && s.scalar <= 0 && this.unmuteTo;   // unmuting a device without a mute
      const c = back && (db == null || db <= -79.5) ? { scalar: this.unmuteTo } : this.levelChange(s, db, muted);
      if (muted !== true) this.unmuteTo = 0;
      return c;
    });
  }
  levelChange(s, db, muted) {
    return {
      ...(db == null ? {} : db <= -79.5 ? { scalar: 0 } : { db }),
      ...(muted !== undefined && s.can_mute ? { muted } : muted === true ? (s.scalar > 0 ? this.muteChange(s, true) : {}) : {}),
    };
  }
  /** What the page gets instead of the digital volume. */
  dto() { const s = this.state; return s && { volumeMode: 'hardware', volumeDb: s.scalar <= 0 ? -80 : Math.max(-80, Math.min(0, s.db)), muted: s.muted || (!s.can_mute && s.scalar <= 0) }; }
  dispose() { clearTimeout(this.timer); this.keys.dispose(); }
}

/** The "MIKU Volume Keys" app: kept in Application Support so it (and its permission) outlives MIKU's updates. */
class VolumeKeys {
  constructor(onKey, onTrust) {
    this.onKey = onKey; this.onTrust = onTrust;
    this.wanted = false; this.trusted = null; this.server = null; this.client = null; this.starting = false; this.failed = 0; this.prompt = false;
  }
  source() {
    const c = [process.env.MIKU_VOLUME_KEYS, process.resourcesPath && path.join(process.resourcesPath, 'MIKU Volume Keys.app'),
      path.join(__dirname, '..', '..', 'build', 'native', 'MIKU Volume Keys.app')];
    return c.find(p => p && fs.existsSync(path.join(p, 'Contents', 'MacOS', 'volumekeys'))) || null;
  }
  /** The installed copy; replaced only when its version changed. */
  install() {
    const src = this.source();
    if (!src) return null;
    const dst = path.join(AppPaths.Root, 'VolumeKeys', 'MIKU Volume Keys.app');
    const version = p => { try { return /CFBundleVersion<\/key>\s*<string>([^<]*)/.exec(fs.readFileSync(path.join(p, 'Contents', 'Info.plist'), 'utf8'))[1]; } catch { return ''; } };
    if (version(dst) !== version(src) || !fs.existsSync(path.join(dst, 'Contents', 'MacOS', 'volumekeys'))) {
      fs.rmSync(dst, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst, { recursive: true });
      Log.info('Volume keys: installed ' + dst);
    }
    return dst;
  }
  want(on) {
    if (on !== this.wanted) { this.wanted = on; this.send(on ? 'on' : 'off'); }
    if (on && !this.client && !this.starting) this.start();
  }
  /** Shows macOS's permission dialog. */
  ask() { this.prompt = true; if (this.client) { this.send('prompt'); this.prompt = false; } else this.start(); }
  send(s) { if (this.client && !this.client.destroyed) this.client.write(s + '\n'); }
  start() {
    if (this.starting || this.client || this.failed >= 3) return;
    this.starting = true;
    let app; try { app = this.install(); } catch (e) { Log.error('Volume keys', e); }
    if (!app) { this.starting = false; this.failed = 3; return; }
    if (this.server) this.launch(app);
    else {
      // the user's own temporary folder (0700); a short path (sun_path holds 104 bytes)
      this.sock = path.join(os.tmpdir(), `miku-vk-${process.pid}.sock`);
      try { fs.unlinkSync(this.sock); } catch { }
      this.server = net.createServer(c => this.connected(c));
      this.server.on('error', e => { Log.error('Volume keys', e); this.server = null; this.starting = false; this.failed = 3; });
      this.server.listen(this.sock, () => this.launch(app));
    }
  }
  launch(app) {
    const args = ['-g', '-n', app, '--args', this.sock, ...(this.prompt ? ['prompt'] : [])];
    this.prompt = false;
    execFile('/usr/bin/open', args, err => { if (err) { Log.info('Volume keys: ' + err.message); this.starting = false; this.failed++; } });
    clearTimeout(this.wait);
    this.wait = setTimeout(() => { if (!this.client) { this.starting = false; this.failed++; Log.info('Volume keys: the helper did not connect'); } }, 10000);
  }
  connected(c) {
    if (this.client) { c.destroy(); return; }
    clearTimeout(this.wait);
    this.client = c; this.starting = false; let buf = '';
    c.setEncoding('ascii');
    c.on('error', () => { });
    c.on('close', () => { if (this.client === c) { this.client = null; this.trusted = null; this.failed++; this.onTrust(); } });
    c.on('data', d => {
      const lines = (buf + d).split('\n'); buf = lines.pop().slice(-200);
      for (const l of lines) {
        const w = l.split(' ');
        if (w[0] === 'trusted') { this.trusted = w[1] === '1'; Log.info('Volume keys: ' + (this.trusted ? 'ready' : 'no Accessibility permission yet')); this.onTrust(); }
        else if (w[0] === 'key' && this.wanted) this.onKey({ key: w[1], fine: w[2] === 'fine' });
      }
    });
    this.send(this.wanted ? 'on' : 'off');
    if (this.prompt) { this.prompt = false; this.send('prompt'); }
  }
  dispose() {
    clearTimeout(this.wait);
    const c = this.client; this.client = null; if (c) c.destroy();
    if (this.server) { this.server.close(); this.server = null; try { fs.unlinkSync(this.sock); } catch { } }
  }
}
module.exports = { DeviceVolume, VolumeKeys };

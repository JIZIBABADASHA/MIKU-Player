'use strict';
// Exclusive mode (hog mode): macOS can't change the volume of the device MIKU holds, nor make it the system output. When
// the listener tries either, MIKU asks whether to switch to shared mode (share-prompt.js). No permission is needed:
//
//   volume keys / Sound slider   they move the system output's volume instead (macOS moved the output off the held
//                                device): `miku-audio --watch-volume` reports that volume changing
//   the held device picked as    Core Audio accepts the request, does nothing and tells no program; its daemon only
//   the system output            logs it, so that one line of the system log is watched (readable by an admin account;
//                                on another account this part stays silent)
// Both run only while MIKU holds a device in exclusive mode.
const { spawn, execFile } = require('child_process');
const readline = require('readline');
const { helperPath } = require('./native-audio');
const { Log } = require('./common');

const SETTLE = 4000;     // macOS moves the output, and restores volumes, by itself right after a hold or an output change
const PREDICATE = 'process == "coreaudiod" AND eventMessage CONTAINS "SetDefaultDevice:" AND eventMessage CONTAINS "\'dOut\'"';

class VolumeAttempt {
  /** held(): the held device in exclusive mode ({ id, name }) or null, now; ask(device): show the prompt. */
  constructor(held, ask) { this.held = held; this.ask = ask; this.procs = []; this.device = null; this.since = 0; this.declined = false; this.quietUntil = 0; this.task = Promise.resolve(); }
  /** The hold may have changed (engine 'changed' / 'devicechange'). */
  update() { this.task = this.task.then(() => this.check()).catch(e => Log.error('Volume attempt', e)); return this.task; }
  async check() {
    const d = await this.held();
    if ((d && d.id) === (this.device && this.device.id)) return;
    this.stop();
    if (d) this.start(d);
  }
  start(d) {
    this.device = d; this.since = Date.now(); this.declined = false; this.quietUntil = 0;
    const helper = helperPath();
    if (helper) this.run(helper, ['--watch-volume'], line => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.e === 'output') this.since = Math.max(this.since, Date.now() - SETTLE + 1500);
      else if (m.e === 'volume' && m.uid !== d.id && !this.declined) this.attempt('volume');
    });
    this.run('/usr/bin/log', ['stream', '--style', 'compact', '--predicate', PREDICATE], line => {
      const m = /SetDefaultDevice:\s*'dOut'\s*\|\s*\d+:\s*'([^']*)'/.exec(line);
      if (m && m[1] === d.id) this.attempt('output');
    });
  }
  run(cmd, args, onLine) {
    let p; try { p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'] }); } catch (e) { Log.error('Volume attempt', e); return; }
    p.on('error', e => Log.info('Volume attempt: ' + e.message));
    p.stdin.on('error', () => { });
    readline.createInterface({ input: p.stdout }).on('line', l => { if (this.procs.includes(p)) onLine(l); });
    this.procs.push(p);
  }
  attempt(how) {
    const now = Date.now();
    if (!this.device || now - this.since < SETTLE || now < this.quietUntil) return;
    this.quietUntil = now + 30000;
    Log.info(`Exclusive output: the listener tries to change the volume (${how === 'output' ? 'picked the held device as the system output' : 'system volume'})`);
    this.ask(this.device);
  }
  /** "Not now": the volume no longer asks until MIKU takes the device again (picking the device still does). */
  decline() { this.declined = true; this.quietUntil = Date.now() + 10000; }
  stop() { const p = this.procs; this.procs = []; this.device = null; for (const x of p) { try { x.stdin.end(); x.kill(); } catch { } } }
}

/** Makes the device the system output, once macOS can (right after hog mode is released it still refuses, silently). */
function makeSystemOutput(uid) {
  const helper = helperPath();
  if (!helper || !uid) return Promise.resolve(false);
  return new Promise(resolve => execFile(helper, ['--set-output', uid], { timeout: 10000 }, (err, out) => {
    const ok = !err && /"ok"\s*:\s*true/.test(String(out));
    if (!ok) Log.info('System output not moved to ' + uid + (err ? ': ' + err.message : ''));
    resolve(ok);
  }));
}
module.exports = { VolumeAttempt, makeSystemOutput };

'use strict';
// Exclusive mode is for a DAC (or headphones) with a volume of its own. The Mac's built-in speakers have only macOS's
// volume, and in hog mode macOS can't change it: the Control Center slider and the volume keys do nothing while MIKU
// holds the speakers (Core Audio refuses property changes on a device another process hogs), and with 固定 0 dB MIKU
// has no slider either. So on the built-in speakers MIKU plays in shared mode even when 獨佔 is chosen; the setting
// itself is kept and applies again on the next DAC.
//
// coreSettings(S) is what the playback cores (MIKU's own and a module's, e.g. Daphne) see: the settings, with
// outputMode read as shared while the device they would play to is built in. refresh() looks the device up again
// (the chosen one; when it is missing or "default", the one the core has open, else the system output: macOS moves
// the system output off a device that is hogged) with the helper's --devices. `openName` gives the open device's name.
const { execFile } = require('child_process');
const { helperPath } = require('./native-audio');
const { Log } = require('./common');

class OutputTarget {
  constructor(settings) { this.s = settings; this.builtIn = false; this.name = ''; this.task = null; this.openName = () => ''; }
  get exclusiveWanted() { return this.s.outputMode === 'coreaudio-exclusive'; }
  /** Exclusive is chosen but the device is the built-in speakers: played in shared mode. */
  get sharedInstead() { return this.exclusiveWanted && this.builtIn; }
  coreSettings() {
    const target = this;
    return new Proxy(this.s, {
      get(s, k, r) { return k === 'outputMode' && target.sharedInstead ? 'coreaudio' : Reflect.get(s, k, r); },
    });
  }
  list() {
    const helper = helperPath();
    if (!helper) return Promise.resolve([]);
    return new Promise(resolve => execFile(helper, ['--devices'], { timeout: 5000, maxBuffer: 4 << 20 }, (err, out) => {
      if (err) { Log.info(`Output devices: ${err.message}`); return resolve(null); }
      try { resolve(JSON.parse(String(out).trim().split('\n').pop()).devices || []); } catch { resolve(null); }
    }));
  }
  /** Looks the device up again; resolves true when the mode the cores see changed. */
  refresh() {
    const run = async () => {
      const before = this.sharedInstead;
      const list = await this.list();
      if (!list) return false;   // keep what was known
      let open = ''; try { open = this.openName() || ''; } catch { }
      const d = (this.s.deviceId && list.find(x => x.id === this.s.deviceId && !x.isDefault)) ||
        (open && list.find(x => x.name === open && !x.isDefault)) || list.find(x => x.isDefault);
      this.builtIn = !!d && d.transport === 'builtin'; this.name = d ? d.name : '';
      if (before !== this.sharedInstead) Log.info(this.sharedInstead
        ? `Exclusive output: ${this.name} is built in (no volume of its own), playing it in shared mode`
        : 'Exclusive output: the device is not built in, exclusive mode applies again');
      return before !== this.sharedInstead;
    };
    this.task = (this.task || Promise.resolve()).catch(() => false).then(run);
    return this.task;
  }
}
module.exports = { OutputTarget };

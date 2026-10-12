'use strict';
// Optional extension modules on macOS: the Mac side of what windows/Host/Extensions.cs does (MIKU.Extensibility/README.md).
// A module is a folder with extension.js (CommonJS, run in this process) and, for its page parts, web/manifest.json:
//
//   <MIKU.app>/Contents/Resources/ext/<id>/      in the installed app
//   <repo>/Extensions/<name>/miku/               in a checkout (mac/app run with Electron)
//
//   module.exports = {
//     id,                               short lower-case id: the RPC and event prefix, and the settings key
//     start(host), stop(),
//     handleRpc(method, args),          the page called ext.<id>.<method>
//     core                              optional playback core: { id, name, info, createEngine(settings) }
//   }
//
// The page reaches a module through ext.<id>.* calls and events, and loads web/ from miku://app/ext/<id>/web/….
// A module that fails to load, start or answer is logged and left out; MIKU itself carries on.
const fs = require('fs');
const path = require('path');
const { Log } = require('./common');

class ExtensionManager {
  constructor() { this.loaded = []; }

  roots() {
    const roots = [];
    if (process.env.MIKU_EXT_DIR) roots.push({ dir: process.env.MIKU_EXT_DIR, sub: '' });
    if (process.resourcesPath) roots.push({ dir: path.join(process.resourcesPath, 'ext'), sub: '' });
    roots.push({ dir: path.join(__dirname, '..', '..', '..', 'Extensions'), sub: 'miku' });
    return roots;
  }

  /** Loads and starts every module found; hostFor(id, dir) builds the host object for one. */
  loadAll(hostFor) {
    for (const { dir: root, sub } of this.roots()) {
      let names = [];
      try { names = fs.readdirSync(root).sort(); } catch { continue; }
      for (const name of names) {
        const dir = path.join(root, name, sub), file = path.join(dir, 'extension.js');
        if (!fs.existsSync(file)) continue;
        try {
          const ext = require(file);
          if (!ext || typeof ext.id !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(ext.id) || this.loaded.some(l => l.ext.id === ext.id)) {
            Log.info(`[ext] skipped ${file}: missing or duplicate id`); continue;
          }
          const l = { ext, dir, scripts: [], styles: [] };
          this.readManifest(l);
          if (ext.start) ext.start(hostFor(ext.id, dir));
          this.loaded.push(l);
          Log.info(`[ext] started ${ext.id} (${dir})`);
        } catch (e) { Log.error('[ext] ' + file, e); }
      }
    }
  }
  /** web/manifest.json: { "scripts": [...], "styles": [...] }, paths relative to web/. */
  readManifest(l) {
    const web = path.join(l.dir, 'web'), file = path.join(web, 'manifest.json');
    if (!fs.existsSync(file)) return;
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    // a version stamp keeps the page from using an old copy after the module is updated
    const url = rel => {
      let stamp = 0; try { stamp = Math.round(fs.statSync(path.join(web, rel)).mtimeMs); } catch { }
      return `miku://app/ext/${l.ext.id}/web/${String(rel).replace(/\\/g, '/')}?v=${stamp.toString(16)}`;
    };
    const urls = key => Array.isArray(m[key]) ? m[key].filter(x => typeof x === 'string' && x).map(url) : [];
    l.scripts = urls('scripts'); l.styles = urls('styles');
  }

  /** For the page: which modules are there and what it should load for them. */
  list() { return this.loaded.map(l => ({ id: l.ext.id, scripts: l.scripts, styles: l.styles })); }
  /** The playback cores the modules provide. */
  cores() {
    const out = [];
    for (const l of this.loaded) {
      try { const c = l.ext.core; if (c && c.id && c.id !== 'miku') out.push(c); } catch (e) { Log.error('[ext] core ' + l.ext.id, e); }
    }
    return out;
  }
  core(id) { return this.cores().find(c => c.id === id) || null; }
  /** miku://app/ext/<id>/web/<file> → the file, only inside the module's web folder. */
  webFile(pathname) {
    const m = /^\/ext\/([a-z][a-z0-9_-]*)\/web\/(.+)$/.exec(pathname);
    const l = m && this.loaded.find(x => x.ext.id === m[1]);
    if (!l) return null;
    const web = path.join(l.dir, 'web') + path.sep, file = path.normalize(path.join(web, m[2]));
    return file.startsWith(web) ? file : null;
  }
  /** ext.<id>.<method> from the page. */
  async rpc(m, a) {
    const rest = m.slice(4), dot = rest.indexOf('.');
    const id = dot < 0 ? rest : rest.slice(0, dot), method = dot < 0 ? '' : rest.slice(dot + 1);
    const l = this.loaded.find(x => x.ext.id === id);
    if (!l) throw new Error(`no extension "${id}"`);
    return l.ext.handleRpc ? (await l.ext.handleRpc(method, a)) ?? null : null;
  }
  stopAll() {
    for (const l of this.loaded) { try { l.ext.stop && l.ext.stop(); } catch (e) { Log.error('[ext] stop ' + l.ext.id, e); } }
  }
}

module.exports = { ExtensionManager };

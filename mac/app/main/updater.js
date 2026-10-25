'use strict';
// 設定 → 其他 → 更新與擴充套件: MIKU's own updates and its extension modules, from the GitHub Releases (the Mac side of
// windows/Host/Updater.cs). A version's Release holds MIKU-<tag>-mac.pkg; the modules built against it are kept apart, in
// its own pre-release tagged extensions-<version> (.github/workflows/extensions.yml):
// MIKU-ext-<id>-<version>-mac-<arm64|x64>.zip with <id>/ inside. Every download is checked against the SHA-256 GitHub keeps.
//
// Modules go to ~/Library/Application Support/MIKU/extensions/<id>/ (extensions.js), never into the signed app. A change
// is staged in extensions/.pending/ and applyPending() carries it out at the next start, before the modules load: a
// module's code is in use while MIKU runs. A staged module carries the MIKU version it was built for (.miku-build) and
// waits for that version, so the modules of an update go in only once MIKU is that version.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { AppPaths, Log } = require('./common');

const Repo = 'JIZIBABADASHA/MIKU-Player';
const BuildFile = '.miku-build';
const Every = 6 * 3600 * 1000;
const Root = path.join(AppPaths.Root, 'extensions');
const Pending = path.join(Root, '.pending');
const CacheDir = path.join(path.dirname(AppPaths.Thumbs), 'Updates');   // ~/Library/Caches/MIKU/Updates
const platform = () => process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
const validId = id => typeof id === 'string' && id.length <= 64 && /^[a-z][a-z0-9_-]*$/.test(id);

/** Dotted versions compared number by number; null sorts first. */
function compare(a, b) {
  if (a == null || b == null) return a == null ? (b == null ? 0 : -1) : 1;
  const x = String(a).replace(/^v/, '').split(/[.+-]/), y = String(b).replace(/^v/, '').split(/[.+-]/);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = parseInt(x[i], 10) || 0, q = parseInt(y[i], 10) || 0;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

const readBuild = dir => { try { return fs.readFileSync(path.join(dir, BuildFile), 'utf8').trim(); } catch { return null; } };
const isModule = dir => fs.existsSync(path.join(dir, 'extension.js'));
const dirs = root => { try { return fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return []; } };

/** At the start, before the modules load: what was staged in extensions/.pending/ for this version. */
function applyPending(version) {
  if (!fs.existsSync(Pending)) return;
  for (const f of fs.readdirSync(Pending).filter(f => f.endsWith('.remove'))) {
    const id = f.slice(0, -7);
    try {
      if (validId(id)) fs.rmSync(path.join(Root, id), { recursive: true, force: true });
      fs.rmSync(path.join(Pending, f), { force: true });
      Log.info(`[ext] removed ${id}`);
    } catch (e) { Log.error('[ext] remove ' + id, e); }
  }
  for (const id of dirs(Pending)) {
    const staged = path.join(Pending, id), dir = path.join(Root, id);
    try {
      if (!validId(id)) { fs.rmSync(staged, { recursive: true, force: true }); continue; }   // a leftover .unpack-…
      const cmp = compare(readBuild(staged), version);
      if (cmp > 0) continue;                                                                // waits for its MIKU update
      if (cmp === 0) {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.renameSync(staged, dir);
        Log.info(`[ext] installed ${id} ${version}`);
      } else fs.rmSync(staged, { recursive: true, force: true });                         // built for an older MIKU
    } catch (e) { Log.error('[ext] install ' + id, e); }
  }
  try { if (!fs.readdirSync(Pending).length) fs.rmdirSync(Pending); } catch { }
}

function parseRelease(r) {
  const tag = r && r.tag_name;
  if (typeof tag !== 'string' || !tag || r.draft || !Array.isArray(r.assets)) throw new Error('GitHub 的 Release 格式不正確');
  const assets = new Map();
  for (const a of r.assets) {
    const digest = /^sha256:([a-f0-9]{64})$/i.exec(a.digest || '');
    // only files of this repository's Release, with the SHA-256 GitHub computed
    if (!a.name || a.state !== 'uploaded' || !digest || !Number.isSafeInteger(a.size) ||
        a.browser_download_url !== `https://github.com/${Repo}/releases/download/${encodeURIComponent(tag)}/${a.name}`) continue;
    assets.set(a.name, { name: a.name, url: a.browser_download_url, sha256: digest[1].toLowerCase(), size: a.size });
  }
  const version = tag.replace(/^v/, ''), suffix = `-${version}-${platform()}.zip`;
  return {
    tag, version, assets,
    installer: assets.get(`MIKU-${tag}-mac.pkg`) || null,
    module: id => assets.get(`MIKU-ext-${id}${suffix}`) || null,
    moduleIds: () => [...assets.keys()].filter(n => n.startsWith('MIKU-ext-') && n.endsWith(suffix)).map(n => n.slice(9, -suffix.length)).filter(validId),
  };
}

// the modules of a version's extensions-<version> Release added to its Release (an older Release holds its own)
function withModules(r, modules) {
  if (modules) for (const [name, a] of modules.assets) if (!r.assets.has(name)) r.assets.set(name, a);
  return r;
}
const modulesTag = version => 'extensions-' + version;

class Updater {
  /** version: this MIKU's; auto(): whether automatic updates are on; changed(): 設定 shows the new state. */
  constructor(version, auto, changed, bundled) {
    this.version = String(version).split('+')[0];
    this.auto = auto; this.changed = changed;
    this.bundled = bundled || null;           // <MIKU.app>/Contents/Resources/ext: modules an older installer put inside
    this.latest = null; this.own = null; this.installer = null;
    this.busy = null; this.error = null; this.progress = null; this.checkedAt = null;
    this.work = Promise.resolve(); this.running = false;
  }

  /** Checks 30 seconds after the start and then every 6 hours while automatic updates are on. */
  start() {
    const tick = () => { if (this.auto() && !this.running) this.check(true).catch(() => { }); };
    this.timers = [setTimeout(tick, 30000), setInterval(tick, Every)];
  }
  stop() { for (const t of this.timers || []) { clearTimeout(t); clearInterval(t); } }

  /** What 設定 shows. */
  info() {
    const newer = !!this.latest && compare(this.latest.version, this.version) > 0;
    return {
      version: this.version, latest: this.latest ? this.latest.version : null, newer,
      // the newest Release has no Mac installer yet (still being uploaded, or Windows only)
      missing: newer && !this.latest.installer,
      ready: newer && !!this.installer,
      busy: this.busy, progress: this.progress, error: this.error, checkedAt: this.checkedAt,
      restart: this.pendingIds().length > 0,
      extensions: this.modules(),
    };
  }

  modules() {
    const installed = new Set(dirs(Root).filter(id => validId(id) && isModule(path.join(Root, id))));
    const bundled = new Set(this.bundled ? dirs(this.bundled).filter(id => validId(id) && isModule(path.join(this.bundled, id))) : []);
    const pending = new Map(this.pendingIds().map(p => [p.id, p.op]));
    const ids = new Set([...installed, ...bundled, ...pending.keys(), ...(this.own ? this.own.moduleIds() : [])]);
    return [...ids].sort().map(id => ({
      id,
      installed: installed.has(id) || bundled.has(id),
      // inside the signed app: it stays until MIKU is reinstalled; a copy added here replaces it
      builtIn: bundled.has(id) && !installed.has(id),
      build: installed.has(id) ? readBuild(path.join(Root, id)) : null,
      available: !!(this.own && this.own.module(id)),
      pending: pending.get(id) || null,
    }));
  }

  pendingIds() {
    const out = [];
    let names = [];
    try { names = fs.readdirSync(Pending, { withFileTypes: true }); } catch { return out; }
    for (const d of names) {
      if (d.isFile() && d.name.endsWith('.remove')) out.push({ id: d.name.slice(0, -7), op: 'remove' });
      // a module staged for an update waits for it: not this start's change
      else if (d.isDirectory() && validId(d.name) && compare(readBuild(path.join(Pending, d.name)), this.version) === 0) out.push({ id: d.name, op: 'install' });
    }
    return out;
  }

  // one job at a time (a check, a download, a module)
  exclusive(fn) {
    const run = this.work.then(async () => { this.running = true; try { return await fn(); } finally { this.running = false; } });
    this.work = run.catch(() => { });
    return run;
  }

  set(busy) { this.busy = busy; if (busy !== 'download' && busy !== 'module') this.progress = null; this.changed(); }

  // ───────────── checking and downloading ─────────────

  /** Asks GitHub for the newest Release and this version's; in the background also downloads a newer installer. */
  check(background = false) {
    return this.exclusive(async () => {
      try {
        this.set('checking');
        const latest = parseRelease(await this.api('latest'));
        withModules(latest, await this.find(modulesTag(latest.version)));
        const own = latest.version === this.version ? latest : await this.findOwn();
        Object.assign(this, { latest, own, checkedAt: new Date().toISOString(), error: null });
        if (background && compare(latest.version, this.version) > 0 && latest.installer) await this.downloadInstaller(latest);
      } catch (e) { Log.error('[update] check', e); this.error = message(e); }
      finally { this.set(null); }
      return this.info();
    });
  }

  async findOwn() {
    // a build of its own (no Release) still finds modules built for its version
    const own = await this.find(this.version) || await this.find('v' + this.version) ||
      parseRelease({ tag_name: this.version, draft: false, assets: [] });
    return withModules(own, await this.find(modulesTag(this.version)));
  }

  async find(tag) {
    try { return parseRelease(await this.api('tags/' + encodeURIComponent(tag))); }
    catch (e) { if (e.status !== 404) throw e; return null; }
  }

  async downloadInstaller(r) {
    if (this.installer && fs.existsSync(this.installer) && this.latest === r) return this.installer;
    this.set('download');
    const file = await this.download(r.installer);
    // older installers in the cache are of no use any more
    for (const f of fs.readdirSync(CacheDir)) if (/^MIKU-.*-mac\.pkg$/.test(f) && path.join(CacheDir, f) !== file) fs.rmSync(path.join(CacheDir, f), { force: true });
    this.installer = file;
    return file;
  }

  /** The newest Release's installer, then its modules for the ones installed; opens the installer and quits MIKU. */
  install(open, quit) {
    return this.exclusive(async () => {
      try {
        const r = this.latest;
        if (!r || compare(r.version, this.version) <= 0) throw new Error('已經是最新版本');
        if (!r.installer) throw new Error('這個版本還沒有 Mac 安裝檔');
        const pkg = await this.downloadInstaller(r);
        // the modules in use, built for the new version, go in at its first start
        for (const id of dirs(Root).filter(id => validId(id) && isModule(path.join(Root, id)) && r.module(id))) await this.stage(r, id);
        this.set('install');
        const err = await open(pkg);
        if (err) throw new Error(err);
        Log.info(`[update] installer for ${r.version} opened`);
        quit();
        return this.info();
      } catch (e) { Log.error('[update] install', e); this.error = message(e); this.set(null); throw new Error(message(e)); }
    });
  }

  // ───────────── extension modules ─────────────

  /** Downloads this version's module and stages it for the next start. */
  addModule(id) {
    if (!validId(id)) return Promise.reject(new Error('未知的擴充套件'));
    return this.exclusive(async () => {
      try {
        if (!this.own) this.own = await this.findOwn();
        if (!this.own || !this.own.module(id)) throw new Error('這個版本沒有這個擴充套件的已編譯版本');
        await this.stage(this.own, id);
        this.error = null;
      } catch (e) { Log.error('[update] add ' + id, e); this.error = message(e); throw new Error(message(e)); }
      finally { this.set(null); }
      return this.info();
    });
  }

  /** Stages the removal of a module for the next start; one only staged is dropped at once. */
  removeModule(id) {
    if (!validId(id)) throw new Error('未知的擴充套件');
    fs.rmSync(path.join(Pending, id), { recursive: true, force: true });
    if (fs.existsSync(path.join(Root, id))) {
      fs.mkdirSync(Pending, { recursive: true });
      fs.writeFileSync(path.join(Pending, id + '.remove'), '');
    }
    this.changed();
    return this.info();
  }

  /** Takes back what is staged for a module (an install or a removal). */
  undo(id) {
    if (!validId(id)) throw new Error('未知的擴充套件');
    fs.rmSync(path.join(Pending, id), { recursive: true, force: true });
    fs.rmSync(path.join(Pending, id + '.remove'), { force: true });
    this.changed();
    return this.info();
  }

  async stage(r, id) {
    this.set('module');
    const zip = await this.download(r.module(id));
    fs.mkdirSync(Pending, { recursive: true });
    const work = path.join(Pending, '.unpack-' + crypto.randomUUID().slice(0, 8));
    try {
      fs.mkdirSync(work);
      // ditto keeps the helpers' executable bits
      await new Promise((resolve, reject) => execFile('/usr/bin/ditto', ['-x', '-k', zip, work], e => e ? reject(e) : resolve()));
      const top = fs.readdirSync(work).filter(n => n !== '__MACOSX'), dir = path.join(work, id);
      if (top.length !== 1 || top[0] !== id || !isModule(dir)) throw new Error(`${id} 的壓縮檔內容不正確`);
      fs.writeFileSync(path.join(dir, BuildFile), r.version);
      const staged = path.join(Pending, id);
      fs.rmSync(staged, { recursive: true, force: true });
      fs.renameSync(dir, staged);
      fs.rmSync(staged + '.remove', { force: true });
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
      fs.rmSync(zip, { force: true });
    }
  }

  // ───────────── GitHub ─────────────

  async api(which) {
    const res = await fetch(`https://api.github.com/repos/${Repo}/releases/${which}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'MIKU-Updater' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) { const e = new Error('GitHub ' + res.status); e.status = res.status; throw e; }
    return res.json();
  }

  /** Downloads into the cache and checks its size and SHA-256; a file already there and correct is kept. */
  async download(a) {
    fs.mkdirSync(CacheDir, { recursive: true });
    const file = path.join(CacheDir, a.name), part = file + '.partial';
    if (fs.existsSync(file) && fs.statSync(file).size === a.size && await sha256(file) === a.sha256) return file;
    const res = await fetch(a.url, { headers: { 'User-Agent': 'MIKU-Updater' }, redirect: 'follow' });
    if (!res.ok || !res.body) { const e = new Error('GitHub ' + res.status); e.status = res.status; throw e; }
    const out = fs.createWriteStream(part);
    let done = 0, last = -1;
    try {
      for await (const chunk of res.body) {
        if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
        done += chunk.length;
        const pct = a.size > 0 ? Math.floor(done * 100 / a.size) : 0;
        if (pct !== last) { last = pct; this.progress = pct / 100; this.changed(); }
      }
    } finally { await new Promise(r => out.end(r)); }
    if (fs.statSync(part).size !== a.size || await sha256(part) !== a.sha256) {
      fs.rmSync(part, { force: true });
      throw new Error(`${a.name} 的 SHA-256 驗證失敗`);
    }
    fs.renameSync(part, file);
    return file;
  }
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function message(e) {
  if (e.status === 404) return 'GitHub 上還沒有發布任何 Release';
  if (e.status === 403 || e.status === 429) return 'GitHub 暫時拒絕連線，請稍後再試';
  if (e.name === 'TypeError' || e.name === 'TimeoutError' || e.name === 'AbortError') return '無法連線到 GitHub';
  if (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'ENOSPC') return '無法寫入 MIKU 的資料夾：' + e.message;
  return e.message;
}

module.exports = { Updater, applyPending, compare, parseRelease, Root };

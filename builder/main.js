'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, session, Notification } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const core = require('./core');
app.setName('MIKU Builder');
app.setPath('userData', process.env.MIKU_BUILDER_DATA_DIR || path.join(app.getPath('appData'), 'MIKU Builder'));
if (!app.requestSingleInstanceLock()) { app.quit(); return; }
let win, busy = false, runner = null, snapshot = null, last = null, output, failureJob = null, autoUpdate = true, lastCheck = 0;
const background = process.argv.includes('--background-update');
const page = pathToFileURL(path.join(__dirname, 'index.html')).href;
const emit = (type, value) => { if (win && !win.isDestroyed()) win.webContents.send('builder:event', { type, value }); };
const stateFile = () => path.join(app.getPath('userData'), 'state.json');
function currentInstall() {
  const mac = process.platform === 'darwin';
  const root = mac ? '/Applications/MIKU.app' : path.join(process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local'), 'Programs', 'MIKU');
  try {
    const version = mac
      ? execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(root, 'Contents', 'Info.plist')], { encoding: 'utf8', timeout: 5000 }).trim()
      : execFileSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{6B3E2A71-4C8D-4F0A-9E57-1D2C3B4A5F60}_is1', '/v', 'DisplayVersion'], { encoding: 'utf8', timeout: 5000 }).match(/DisplayVersion\s+REG_SZ\s+(\S+)/)?.[1];
    if (!version) return null;
    // the modules MIKU will load: those this downloader added, and on the Mac any an older installer put in the app
    const ids = new Set(core.installedExtensions(extRoot(), catalog()));
    if (mac) for (const id of core.installedExtensions(path.join(root, 'Contents/Resources/ext'), catalog())) ids.add(id);
    return { version, extensions: [...ids].sort() };
  } catch { return null; }
}
const catalog = () => require('./catalog.json').extensions;
const extRoot = () => core.extensionRoot(process.platform);
function matchesInstall(install, wanted) {
  return !!install && install.version === wanted.version && JSON.stringify(install.extensions) === JSON.stringify(wanted.extensions.map(e => e.id).sort());
}
// Puts the downloaded modules in place once this computer runs the Release they were built for.
async function installModules(r) {
  const ids = await core.installExtensions({ result: last, catalog: catalog(), root: extRoot(), platform: process.platform, runner: r, stage: (id, text) => emit('stage', { id, text }) });
  last.zips = []; save();
  return ids;
}
function save() {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(stateFile() + '.tmp', JSON.stringify({ output, last, autoUpdate, lastCheck }, null, 2));
  fs.renameSync(stateFile() + '.tmp', stateFile());
}
function registerUpdater() {
  // Keep a private installed copy so deleting/moving the original download doesn't break player updates.
  // Development runs never register with the user's real player.
  if (!app.isPackaged && path.resolve(app.getAppPath()) !== path.resolve(process.resourcesPath, 'app')) return;
  const runtime = path.join(app.getPath('userData'), 'runtime');
  if (!autoUpdate) {
    fs.writeFileSync(path.join(app.getPath('userData'), 'updater.json'), JSON.stringify({ enabled: false, executable: process.execPath, args: [] }, null, 2));
    if (fs.existsSync(runtime)) for (const name of fs.readdirSync(runtime)) {
      const old = path.join(runtime, name);
      if (/^v[0-9]+(?:\.[0-9]+)*$/.test(name) && !path.resolve(process.execPath).startsWith(path.resolve(old) + path.sep))
        try { fs.rmSync(old, { recursive: true, force: true }); } catch {}
    }
    return;
  }
  const source = process.platform === 'darwin' ? path.resolve(process.execPath, '../../..') : path.dirname(process.execPath);
  const destination = path.join(runtime, `v${require('./package.json').version}`, path.basename(source));
  const marker = destination + '.ready';
  if (path.resolve(source) !== path.resolve(destination) && !fs.existsSync(marker)) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    // APFS can clone files without doubling their physical storage; other filesystems fall back to copying.
    fs.cpSync(source, destination, { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE });
    // Marker lives outside the signed Mac bundle.
    fs.writeFileSync(marker, 'ready');
  }
  const executable = path.join(destination, path.relative(source, process.execPath));
  fs.writeFileSync(path.join(app.getPath('userData'), 'updater.json'), JSON.stringify({ enabled: autoUpdate, executable, args: [] }, null, 2));
  // A new downloader version replaces its old private runtime copy to avoid accumulating Electron bundles.
  for (const name of fs.readdirSync(runtime)) {
    const old = path.join(runtime, name);
    if (old === path.dirname(destination) || !/^v[0-9]+(?:\.[0-9]+)*$/.test(name) ||
        path.resolve(process.execPath).startsWith(path.resolve(old) + path.sep)) continue;
    fs.rmSync(old, { recursive: true, force: true });
  }
}
function notifyReady(result) {
  emit('result', result);
  win.show();
  if (Notification.isSupported()) {
    const note = new Notification({ title: 'MIKU 更新已準備完成', body: '播放器與已選套件的安裝檔已下載，開啟即可更新。' });
    note.on('click', () => { win.show(); win.focus(); }); note.show();
  }
}
async function backgroundUpdate() {
  const closeIfHidden = () => { if (!win.isVisible()) app.quit(); };
  if (!autoUpdate || Date.now() - lastCheck < 6 * 60 * 60 * 1000) { closeIfHidden(); return; }
  try {
    const installed = currentInstall();
    if (!installed) { closeIfHidden(); return; }
    let ready = null;
    await exclusive(async r => {
      snapshot = await core.latest(r.controller.signal, process.arch); emit('snapshot', snapshot);
      lastCheck = Date.now(); save();
      if (core.compareVersions(installed.version, snapshot.version) >= 0) return;
      const ids = last?.extensions?.map(e => e.id) || installed.extensions;
      if (ids.some(id => !snapshot.extensions.some(e => e.id === id && e.platforms.includes(process.platform)))) throw new Error('已安裝的套件不在目前清單中，請重新選擇套件。');
      // wait for a Release that has every module this listener uses
      const build = snapshot.builds.find(b => b.platform === process.platform);
      if (!build || ids.some(id => !build.extensions.includes(id))) return;
      const wanted = core.installedManifest(snapshot, snapshot.extensions.filter(e => ids.includes(e.id)), process.platform);
      if (last?.artifact && !last.installed && core.sameBuild(last, wanted) && fs.existsSync(last.artifact)) { ready = last; return; }
      ready = await core.downloadInstaller({ snapshot, ids, output, platform: process.platform, runner: r, stage: (id, text) => emit('stage', { id, text }) });
      last = ready; save();
    });
    if (ready) notifyReady(ready); else closeIfHidden();
  } catch (e) {
    // Offline checks remain quiet; a missing published installer needs user action.
    if (['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED'].includes(e.code) || e.status === 403 || e.status === 429) { closeIfHidden(); return; }
    failureJob = e.job;
    emit('backgroundError', { message: e.message, checks: e.checks, job: e.job }); win.show();
  }
}
function handle(name, fn) {
  ipcMain.handle('builder:' + name, async (event, ...args) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== page) throw new Error('無效的要求來源。');
    try { return { ok: true, value: await fn(...args) }; }
    catch (e) { return { ok: false, error: e.message, checks: e.checks, job: e.job }; }
  });
}
async function exclusive(action) {
  if (busy) throw new Error('已有工作正在執行。');
  busy = true;
  runner = new core.Runner(s => emit('log', s), core.environment());
  emit('busy', true);
  try { return await action(runner); }
  finally { runner = null; busy = false; emit('busy', false); }
}
app.whenReady().then(() => {
  output = path.join(app.getPath('downloads'), 'miku player');
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    const oldDefault = path.join(app.getPath('downloads'), 'MIKU Builds');
    if (typeof saved.output === 'string' && path.isAbsolute(saved.output) && saved.output !== oldDefault) output = saved.output;
    if (saved.last?.platform === process.platform) last = saved.last;
    autoUpdate = saved.autoUpdate !== false;
    lastCheck = Number(saved.lastCheck) || 0;
  } catch {}
  let moduleNotice = '';
  async function cleanupInstalled() {
    if (busy || !last?.job || !last.tag || last.installed) return;
    try {
      if (currentInstall()?.version !== last.version) return;
      // the installer has run: now the modules built for this Release
      if (last.zips?.length) await exclusive(installModules);
      // Only remove the installer created under this downloader's own output directory.
      if (last.artifact && path.isAbsolute(last.artifact) && path.dirname(last.artifact) === last.job && path.dirname(last.job) === last.downloadRoot && path.basename(last.artifact).startsWith('MIKU-'))
        fs.rmSync(last.artifact, { force: true });
      try { fs.rmdirSync(last.job); } catch {}
      last.artifact = null; last.installed = true; save();
      emit('installed', last);
      emit('stage', { id: 'done', text: '安裝完成，已清理暫存檔；重新開啟 MIKU 後擴充套件生效' });
    } catch (e) {
      // retried every 30 seconds (MIKU may still be open); said once
      if (e.message !== moduleNotice) { moduleNotice = e.message; emit('notice', e.message); }
    }
  }
  cleanupInstalled();
  const cleanupTimer = setInterval(cleanupInstalled, 30000);
  cleanupTimer.unref();
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
  handle('initial', () => ({ platform: process.platform, arch: process.arch, output, last, installed: currentInstall(), autoUpdate, background, catalog: require('./catalog.json'), version: require('./package.json').version }));
  handle('auto', enabled => {
    if (busy || typeof enabled !== 'boolean') throw new Error('目前無法變更更新設定。');
    const previous = autoUpdate;
    autoUpdate = enabled; save();
    try { registerUpdater(); } catch (e) { autoUpdate = previous; save(); throw e; }
    return autoUpdate;
  });
  handle('refresh', () => exclusive(async r => {
    emit('stage', { id: 'check', text: '正在檢查 GitHub 最新內容…' });
    snapshot = await core.latest(r.controller.signal, process.arch);
    emit('snapshot', snapshot);
    emit('stage', { id: 'ready', text: '已取得 GitHub 最新版本' });
    return snapshot;
  }));
  handle('choose', async () => {
    if (busy) throw new Error('請等待目前工作結束。');
    const result = await dialog.showOpenDialog(win, { title: '選擇安裝檔下載資料夾', defaultPath: output, properties: ['openDirectory', 'createDirectory'] });
    if (!result.canceled) { output = result.filePaths[0]; save(); }
    return output;
  });
  const selected = ids => {
    const catalog = snapshot?.extensions || require('./catalog.json').extensions;
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some(id => !catalog.some(e => e.id === id && e.platforms.includes(process.platform)))) throw new Error('無效的套件選擇。');
    return catalog.filter(e => ids.includes(e.id));
  };
  handle('build', ids => exclusive(async r => {
    selected(ids); failureJob = null;
    emit('stage', { id: 'check', text: '確認 GitHub 最新版本…' });
    snapshot = await core.latest(r.controller.signal, process.arch);
    emit('snapshot', snapshot);
    try {
      const wanted = core.installedManifest(snapshot, selected(ids), process.platform);
      const installedVersion = currentInstall()?.version;
      if (core.compareVersions(installedVersion, snapshot.version) > 0)
        throw new Error(`這台電腦已安裝 MIKU ${installedVersion}，比 GitHub 最新 Release ${snapshot.version} 更新；已停止下載以避免降版。`);
      const install = currentInstall();
      if (matchesInstall(install, { ...wanted, version: snapshot.version })) {
        last = { ...wanted, version: snapshot.version, tag: snapshot.tag, createdAt: new Date().toISOString(), artifact: null, zips: [], installed: true };
        save(); try { registerUpdater(); } catch (e) { emit('notice', `更新工具無法設定：${e.message}`); }
        emit('stage', { id: 'done', text: '目前已安裝最新版本與所選套件' });
        return last;
      }
      // this Release's MIKU is already here: only the modules change, no installer
      const sameVersion = install?.version === snapshot.version;
      const result = await core.downloadInstaller({ snapshot, ids, output, platform: process.platform, runner: r, stage: (id, text) => emit('stage', { id, text }), installer: !sameVersion });
      last = result; save(); try { registerUpdater(); } catch (e) { emit('notice', `更新工具無法設定：${e.message}`); }
      if (sameVersion) {
        await installModules(r);
        try { fs.rmdirSync(last.job); } catch {}
        last.installed = true; save();
        emit('stage', { id: 'done', text: '擴充套件已安裝，重新開啟 MIKU 後生效' });
        return last;
      }
      const openError = await shell.openPath(result.artifact);
      if (openError) emit('notice', `安裝檔已下載，但無法自動開啟：${openError}`);
      else { emit('stage', { id: 'done', text: '安裝程式已開啟，請完成系統安裝步驟' }); setTimeout(cleanupInstalled, 30000).unref(); }
      return result;
    } catch (e) { failureJob = e.job; throw e; }
  }));
  handle('cancel', async () => { if (runner) await runner.stop(); });
  handle('open', async kind => {
    // once installed, the folder is where the modules went (the download folder is cleaned up by then)
    const folder = () => {
      if (last?.installed) { const root = extRoot(); fs.mkdirSync(root, { recursive: true }); return root; }
      return last?.job && fs.existsSync(last.job) ? last.job : output;
    };
    const target = kind === 'installer' ? last?.artifact : kind === 'failure' ? failureJob : kind === 'folder' ? folder() : null;
    if (!target || !fs.existsSync(target)) throw new Error('找不到檔案或資料夾。');
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    if (kind === 'installer') setTimeout(cleanupInstalled, 30000).unref();
  });
  handle('help', async key => {
    if (!Object.hasOwn(core.HELP, key)) throw new Error('未知的說明連結。');
    await shell.openExternal(core.HELP[key]);
  });
  win = new BrowserWindow({ title: 'MIKU 下載器', width: 1040, height: 850, minWidth: 760, minHeight: 620, show: !background, backgroundColor: '#0d0f13', webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.on('close', e => {
    if (busy) {
      e.preventDefault();
      emit('notice', '工作仍在執行，請先按「停止」，待停止後再關閉視窗。');
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  if (background) win.webContents.once('did-finish-load', () => { setTimeout(() => backgroundUpdate(), 500); });
});
app.on('second-instance', (_event, args) => {
  if (args.includes('--background-update')) { if (!busy && win) void backgroundUpdate(); return; }
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
});
app.on('window-all-closed', () => app.quit());

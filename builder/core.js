'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const BASE = { repo: 'JIZIBABADASHA/MIKU-Player', ref: 'main' };
const SHA = /^[a-f0-9]{40}$/;
const HELP = {
  cpp: 'https://visualstudio.microsoft.com/visual-cpp-build-tools/',
  cmake: 'https://cmake.org/download/',
  xcode: 'https://developer.apple.com/xcode/resources/',
};

function safePart(s) {
  return typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(s) &&
    !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(s);
}
function safeFile(s) {
  return typeof s === 'string' && s.length < 200 && s.split('/').every(p =>
    p && p !== '.' && p !== '..' && /^[a-zA-Z0-9_.-]+$/.test(p));
}
function validateCatalog(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.extensions) || value.extensions.length > 50)
    throw new Error('套件清單格式不支援；請更新 MIKU Builder。');
  const ids = new Set(), dirs = new Set();
  for (const e of value.extensions) {
    if (!safePart(e.id) || e.id !== e.id.toLowerCase() || !safePart(e.directory) ||
      ids.has(e.id) || dirs.has(e.directory.toLowerCase()) ||
      typeof e.name !== 'string' || e.name.length > 100 ||
      typeof e.description !== 'string' || e.description.length > 500 ||
      !/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(e.repo) ||
      typeof e.ref !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,199}$/.test(e.ref) ||
      !Array.isArray(e.platforms) || !e.platforms.length || e.platforms.some(p => !['darwin', 'win32'].includes(p)) ||
      !Array.isArray(e.requirements) || e.requirements.some(r => !['cmake', 'cpp'].includes(r)) ||
      e.platforms.some(p => !Array.isArray(e.files?.[p]) || !e.files[p].length || e.files[p].some(f => !safeFile(f))))
      throw new Error('GitHub 的套件清單包含無效或重複的欄位。');
    ids.add(e.id); dirs.add(e.directory.toLowerCase());
  }
  return value;
}

function request(url, signal, redirects = 0) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !['api.github.com', 'raw.githubusercontent.com', 'codeload.github.com', 'github.com', 'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com', 'objects.githubusercontent.com'].includes(u.hostname))
    return Promise.reject(new Error('不支援的下載來源。'));
  return new Promise((resolve, reject) => {
    const req = https.get(u, { signal, headers: { 'User-Agent': 'MIKU-Builder', Accept: 'application/vnd.github+json' } }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects >= 4) return reject(new Error('GitHub 重新導向次數過多。'));
        resolve(request(new URL(res.headers.location, u).href, signal, redirects + 1));
      } else if (res.statusCode !== 200) {
        res.resume();
        const error = new Error(`GitHub 回應 ${res.statusCode}。${res.statusCode === 403 || res.statusCode === 429 ? '請求太頻繁，請稍後重試。' : '請確認網路、儲存庫與版本是否可用。'}`);
        error.status = res.statusCode; reject(error);
      } else resolve(res);
    });
    req.setTimeout(45000, () => req.destroy(new Error('GitHub 連線逾時，請重試。')));
    req.on('error', reject);
  });
}
async function json(url, signal) {
  const res = await request(url, signal);
  let size = 0; const chunks = [];
  for await (const chunk of res) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) { res.destroy(); throw new Error('GitHub 資料超過大小限制。'); }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function resolveCommit(repo, ref, signal) {
  const result = await json(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`, signal);
  if (!SHA.test(result.sha)) throw new Error(`無法確認 ${repo} 的版本。`);
  return result.sha;
}
async function latestSource(signal) {
  const base = { ...BASE, sha: await resolveCommit(BASE.repo, BASE.ref, signal) };
  let catalog, catalogNotice = '';
  try { catalog = await json(`https://raw.githubusercontent.com/${BASE.repo}/${base.sha}/builder/catalog.json`, signal); }
  catch (e) {
    if (e.status !== 404) throw e;
    catalog = require('./catalog.json');
    catalogNotice = 'GitHub 尚未提供套件清單，目前使用下載器內建清單。';
  }
  validateCatalog(catalog);
  const extensions = [];
  // Sequential requests avoid bursts against GitHub's unauthenticated API limit.
  for (const ext of catalog.extensions) extensions.push({ ...ext, sha: await resolveCommit(ext.repo, ext.ref, signal) });
  return { base, extensions, catalogNotice, checkedAt: new Date().toISOString() };
}
const ASSET_SHA = /^sha256:([a-f0-9]{64})$/;
// What the Extensions workflow (.github/workflows/extensions.yml) adds to a Release for each module, built against
// that Release's MIKU: MIKU-ext-<id>-<version>-<win-x64|mac-arm64|mac-x64>.zip, holding <id>/ as MIKU loads it.
function extPlatform(platform, arch) {
  if (platform === 'win32') return 'win-x64';
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  throw new Error('目前僅支援 macOS 與 Windows。');
}
function extAssetName(id, version, platform, arch) { return `MIKU-ext-${id}-${version}-${extPlatform(platform, arch)}.zip`; }
function validateRelease(release, arch = process.arch) {
  const tag = release?.tag_name;
  if (release?.draft || release?.prerelease || typeof tag !== 'string' ||
      !/^v?[0-9][0-9A-Za-z.+-]{0,79}$/.test(tag) || !Array.isArray(release.assets))
    throw new Error('GitHub 最新 Release 格式不正確。');
  const version = tag.replace(/^v/, '');
  const asset = name => {
    const a = release.assets.find(x => x.name === name && x.state === 'uploaded');
    if (!a) return null;
    const digest = ASSET_SHA.exec(a.digest || '');
    if (!digest || !Number.isSafeInteger(a.size) || a.size < 1024 ||
        a.browser_download_url !== `https://github.com/${BASE.repo}/releases/download/${encodeURIComponent(tag)}/${name}`)
      throw new Error(`GitHub 檔案 ${name} 缺少 SHA-256、大小或安全下載網址。`);
    return { asset: name, sha256: digest[1], size: a.size, url: a.browser_download_url };
  };
  const catalog = validateCatalog(require('./catalog.json'));
  const installers = { darwin: `MIKU-${tag}-mac.pkg`, win32: `MIKU-Setup-${tag}.exe` };
  const builds = [];
  for (const [platform, name] of Object.entries(installers)) {
    const installer = asset(name);
    if (!installer) continue;
    // each module this Release built for this computer (the Mac's own architecture)
    const extensions = {};
    for (const e of catalog.extensions) {
      if (!e.platforms.includes(platform)) continue;
      const zip = asset(extAssetName(e.id, version, platform, arch));
      if (zip) extensions[e.id] = zip;
    }
    builds.push({ platform, ...installer, extensions: Object.keys(extensions), zips: extensions });
  }
  if (!builds.length) throw new Error('最新 GitHub Release 沒有相容的 MIKU 安裝檔。');
  return { tag, version, base: { repo: BASE.repo, ref: tag, sha: tag },
    extensions: catalog.extensions.map(e => ({ ...e, sha: tag })), builds,
    checkedAt: new Date().toISOString() };
}
async function latest(signal, arch = process.arch) {
  let release;
  try { release = await json(`https://api.github.com/repos/${BASE.repo}/releases/latest`, signal); }
  catch (e) { if (e.status === 404) throw new Error('GitHub 尚未發布 MIKU Release。'); throw e; }
  return validateRelease(release, arch);
}
function selectBuild(snapshot, ids, platform) {
  if (!['darwin', 'win32'].includes(platform) || !Array.isArray(ids) || new Set(ids).size !== ids.length ||
      ids.some(id => typeof id !== 'string' || !snapshot.extensions?.some(e => e.id === id))) throw new Error('無效的系統或套件選擇。');
  const entry = snapshot.builds?.find(x => x.platform === platform);
  if (!entry) throw new Error('這個系統目前沒有可用的安裝檔。');
  const missing = ids.filter(id => !entry.zips?.[id]);
  if (missing.length) throw new Error(`這個 Release 尚未提供 ${missing.join('、')} 的已編譯版本。`);
  return entry;
}
// Downloads into dir and checks size and SHA-256; a file already there and correct is kept.
async function fetchVerified(file, dir, runner, stage, label) {
  const target = path.join(dir, file.asset);
  if (fs.existsSync(target)) {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
    if (fs.statSync(target).size === file.size && hash.digest('hex') === file.sha256) return target;
    fs.rmSync(target, { force: true });
  }
  const partial = target + '.partial';
  fs.rmSync(partial, { force: true });
  stage('download', `下載${label}`);
  try {
    const response = await request(file.url, runner.controller.signal);
    const hash = createHash('sha256'); let bytes = 0, lastTick = 0;
    response.on('data', chunk => {
      bytes += chunk.length; hash.update(chunk);
      if (Date.now() - lastTick > 500) { lastTick = Date.now(); stage('download', `下載${label} · ${(bytes / 1048576).toFixed(1)} / ${(file.size / 1048576).toFixed(1)} MB`); }
    });
    await pipeline(response, fs.createWriteStream(partial, { flags: 'wx' }), { signal: runner.controller.signal });
    stage('verify', `核對${label}的完整性`);
    if (bytes !== file.size || hash.digest('hex') !== file.sha256) throw new Error(`${file.asset} 與 GitHub 發行版本不符，已刪除；請重試。`);
    runner.check(); fs.renameSync(partial, target);
    return target;
  } catch (e) { fs.rmSync(partial, { force: true }); throw e; }
}
// installer: false when this computer already has the Release's MIKU and only the modules change.
async function downloadInstaller({ snapshot, ids, output, platform, runner, stage, installer = true }) {
  const entry = selectBuild(snapshot, ids, platform);
  const selected = snapshot.extensions.filter(e => ids.includes(e.id));
  const job = path.join(output, `MIKU-${snapshot.tag}-${platform}-${ids.join('-') || 'base'}`);
  fs.mkdirSync(job, { recursive: true });
  try {
    const artifact = installer ? await fetchVerified(entry, job, runner, stage, ' MIKU 安裝檔') : null;
    const zips = [];
    for (const e of selected) zips.push({ id: e.id, file: await fetchVerified(entry.zips[e.id], job, runner, stage, ` ${e.name}`) });
    stage('done', installer ? '安裝檔已備妥，請開啟安裝' : '擴充套件已備妥');
    return { platform, version: snapshot.version, tag: snapshot.tag, createdAt: new Date().toISOString(), base: snapshot.base,
      extensions: selected.map(({ id, repo, ref, sha }) => ({ id, repo, ref, sha })), artifact, zips, job, downloadRoot: output };
  } catch (e) {
    try { fs.rmdirSync(job); } catch {}
    throw e;
  }
}
// Where MIKU loads the modules a listener adds: next to MIKU.exe on Windows (installed per user, writable), and the
// user's MIKU folder on the Mac (mac/app/main/extensions.js), as the signed app bundle is replaced on every update.
function extensionRoot(platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'MIKU', 'ext');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'MIKU', 'extensions');
  throw new Error('目前僅支援 macOS 與 Windows。');
}
function installedExtensions(root, catalog) {
  return catalog.filter(e => fs.existsSync(path.join(root, e.id))).map(e => e.id).sort();
}
// Unpacks each module beside the old one and swaps it in, so a failure leaves the old module; modules from the
// catalog that were not chosen are removed. Folders the catalog does not name are never touched.
async function installExtensions({ result, catalog, root, platform, runner, stage }) {
  stage('verify', '安裝擴充套件');
  fs.mkdirSync(root, { recursive: true });
  const staging = path.join(root, `.miku-install-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(staging);
  try {
    for (const { id, file } of result.zips || []) {
      const ext = catalog.find(e => e.id === id);
      if (!ext) throw new Error(`未知的擴充套件：${id}`);
      const into = path.join(staging, id + '.unpack');
      fs.mkdirSync(into);
      if (platform === 'win32') await runner.run('powershell.exe', psArgs(`$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${psString(file)} -DestinationPath ${psString(into)}`));
      else await runner.run('/usr/bin/ditto', ['-x', '-k', file, into]);
      const entries = fs.readdirSync(into);
      if (entries.length !== 1 || entries[0] !== id || !fs.statSync(path.join(into, id)).isDirectory()) throw new Error(`${ext.name} 的壓縮檔結構不正確。`);
      for (const f of ext.files[platform]) requireFile(path.join(into, id, f));
    }
    runner.check();
    const chosen = new Set((result.zips || []).map(z => z.id));
    for (const ext of catalog) {
      const dest = path.join(root, ext.id), old = path.join(staging, ext.id + '.old');
      if (!chosen.has(ext.id) && !fs.existsSync(dest)) continue;
      try { if (fs.existsSync(dest)) fs.renameSync(dest, old); }
      catch { throw new Error(`無法替換 ${ext.name}：請先關閉 MIKU 再重試。`); }
      if (chosen.has(ext.id)) fs.renameSync(path.join(staging, ext.id + '.unpack', ext.id), dest);
    }
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  for (const { file } of result.zips || []) fs.rmSync(file, { force: true });
  return installedExtensions(root, catalog);
}

class Runner {
  constructor(log, env = process.env) {
    this.log = log; this.env = { ...env, CI: '1', GIT_TERMINAL_PROMPT: '0' };
    this.controller = new AbortController(); this.child = null;
  }
  check() { if (this.controller.signal.aborted) throw new Error('已取消。'); }
  async stop() {
    this.controller.abort();
    const child = this.child;
    if (!child?.pid) return;
    if (process.platform === 'win32') {
      await new Promise(resolve => {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        killer.on('error', resolve); killer.on('close', resolve);
      });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch { try { child.kill('SIGKILL'); } catch {} }
    }
  }
  run(exe, args, cwd, timeout = 60 * 60 * 1000) {
    this.check();
    this.log(`\n> ${path.basename(exe)} ${args.join(' ')}\n`);
    return new Promise((resolve, reject) => {
      let tail = '', expired = false;
      const child = spawn(exe, args, { cwd, env: this.env, shell: false, windowsHide: true, detached: process.platform !== 'win32' });
      this.child = child;
      const timer = setTimeout(() => { expired = true; void this.stop(); }, timeout);
      const append = data => { const s = data.toString(); tail = (tail + s).slice(-64000); this.log(s); };
      child.stdout.on('data', append); child.stderr.on('data', append);
      const clean = () => { clearTimeout(timer); if (this.child === child) this.child = null; };
      child.on('error', e => { clean(); reject(new Error(`無法啟動 ${path.basename(exe)}：${e.message}`)); });
      child.on('close', code => {
        clean();
        if (expired) reject(new Error('執行逾時，已停止；詳細內容請查看紀錄。'));
        else if (this.controller.signal.aborted) reject(new Error('已取消。'));
        else if (code !== 0) reject(new Error(`${path.basename(exe)} 執行失敗（${code}）。\n${tail.slice(-2500)}`));
        else resolve(tail.trim());
      });
    });
  }
}
function psString(s) { return "'" + s.replaceAll("'", "''") + "'"; }
function psArgs(script) { return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]; }
function environment() {
  const env = { ...process.env };
  if (process.platform === 'darwin') env.PATH = [...new Set([...(env.PATH || '').split(':'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
  return env;
}
function sameBuild(a, b) {
  if (!a || !b || a.platform !== b.platform) return false;
  const release = Boolean(a.tag || b.tag);
  if (release ? !a.tag || a.tag !== b.tag : a.base?.sha !== b.base?.sha) return false;
  const list = x => (x.extensions || []).map(e => release ? e.id : `${e.id}:${e.sha}`).sort().join('|');
  return list(a) === list(b);
}
function compareVersions(a, b) {
  const parse = value => typeof value === 'string' && /^\d+(?:\.\d+){1,3}$/.test(value) ? value.split('.').map(Number) : null;
  const left = parse(a), right = parse(b);
  if (!left || !right) return null;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) > (right[i] || 0) ? 1 : -1;
  }
  return 0;
}
function installedManifest(snapshot, selected, platform) {
  return { schemaVersion: 2, tag: snapshot.tag, platform, base: snapshot.base, extensions: selected.map(({ id, repo, ref, sha }) => ({ id, repo, ref, sha })) };
}
function prepareUpdater(root, platform) {
  const bridgeDir = fs.existsSync(path.join(__dirname, 'bridge')) ? path.join(__dirname, 'bridge') : null;
  const copy = (name, target, original) => {
    if (!fs.existsSync(path.join(root, target))) fs.copyFileSync(bridgeDir ? path.join(bridgeDir, name) : path.join(__dirname, '..', original), path.join(root, target));
  };
  const patch = (file, token, needle, replacement) => {
    const target = path.join(root, file), text = fs.readFileSync(target, 'utf8');
    if (text.includes(token)) return;
    if (!text.includes(needle)) throw new Error(`目前 GitHub 的 ${file} 不相容，請更新 MIKU Builder。`);
    fs.writeFileSync(target, text.replace(needle, replacement));
  };
  if (platform === 'darwin') {
    copy('updater.js', 'mac/app/main/updater.js', 'mac/app/main/updater.js');
    patch('mac/app/main/main.js', "require('./updater').start", '  createWindow();', "  createWindow();\n  require('./updater').start(Log);");
    // Older packages merged files into the old bundle, which could retain a deselected extension.
    patch('mac/build/make_pkg.py', '<upgrade-bundle><bundle', '    <upgrade-bundle/>', '    <upgrade-bundle><bundle id="{BUNDLE_ID}"/></upgrade-bundle>');
  } else {
    copy('BuilderUpdater.cs', 'windows/Host/BuilderUpdater.cs', 'windows/Host/BuilderUpdater.cs');
    patch('windows/Program.cs', 'Host.BuilderUpdater.Start();', 'Application.Run(new Host.MainForm());', 'Host.BuilderUpdater.Start();\n        Application.Run(new Host.MainForm());');
    patch('windows/MIKU.csproj', 'Update="build-manifest.json"', '</Project>', '  <ItemGroup><None Update="build-manifest.json" CopyToOutputDirectory="PreserveNewest" CopyToPublishDirectory="PreserveNewest" /></ItemGroup>\n</Project>');
    patch('windows/installer.iss', 'Name: "{app}\\ext"', '[Files]', '#ifexist "dist\\MIKU\\build-manifest.json"\n[InstallDelete]\nType: filesandordirs; Name: "{app}\\ext"\n#endif\n\n[Files]');
  }
}
async function preflight(platform, extensions, runner) {
  const checks = [];
  const probe = async (name, exe, args, help) => {
    try { await runner.run(exe, args, undefined, 20000); checks.push({ name, ok: true }); }
    catch (e) { runner.check(); checks.push({ name, ok: false, help, detail: e.message }); }
  };
  if (platform === 'darwin') {
    await probe('Apple 命令列開發工具', 'xcrun', ['--find', 'clang'], 'xcode');
    await probe('Python 3', 'python3', ['--version'], 'xcode');
    if (extensions.some(e => e.requirements.includes('cmake'))) await probe('CMake', runner.env.CMAKE || 'cmake', ['--version'], 'cmake');
  } else if (platform === 'win32') {
    await probe('Windows PowerShell', 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']);
    if (extensions.some(e => e.requirements.includes('cpp'))) {
      // Daphne uses CMake's default Visual Studio generator, so require VS 2022 C++ specifically.
      const script = "$v = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\\Installer\\vswhere.exe'; if (!(Test-Path $v)) { exit 1 }; $p = & $v -latest -products * -version '[17.0,18.0)' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath; if (!$p) { exit 1 }; Write-Output $p";
      let vs = '';
      try { vs = await runner.run('powershell.exe', psArgs(script), undefined, 20000); checks.push({ name: 'Visual Studio 2022 C++ Build Tools', ok: true }); }
      catch (e) { runner.check(); checks.push({ name: 'Visual Studio 2022 C++ Build Tools（含 Windows SDK）', ok: false, help: 'cpp' }); }
      if (vs) {
        const bundled = path.join(vs.trim(), 'Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'CMake', 'CMake', 'bin');
        if (fs.existsSync(path.join(bundled, 'cmake.exe'))) {
          const currentPath = runner.env.Path || runner.env.PATH || '';
          delete runner.env.PATH; runner.env.Path = `${bundled};${currentPath}`;
        }
      }
    }
    if (extensions.some(e => e.requirements.includes('cmake'))) await probe('CMake', 'cmake.exe', ['--version'], 'cmake');
    checks.push({ name: '.NET 8 SDK、FFmpeg、Inno Setup（建置時自動準備）', ok: true, automatic: true });
  } else throw new Error('目前僅支援 macOS 與 Windows。');
  return checks;
}

async function downloadSource(source, destination, runner, progress) {
  runner.check();
  if (!SHA.test(source.sha)) throw new Error('來源缺少確定的 GitHub commit。');
  const staging = destination + '.extract', archive = destination + '.zip';
  if (fs.existsSync(destination) || fs.existsSync(staging)) throw new Error('下載目標已存在，請重新開始。');
  fs.mkdirSync(staging, { recursive: true });
  try {
    const response = await request(`https://codeload.github.com/${source.repo}/zip/${source.sha}`, runner.controller.signal);
    let bytes = 0, last = 0;
    response.on('data', chunk => {
      bytes += chunk.length;
      if (Date.now() - last > 500) { last = Date.now(); progress(`下載 ${source.repo} · ${(bytes / 1048576).toFixed(1)} MB`); }
    });
    await pipeline(response, fs.createWriteStream(archive, { flags: 'wx' }), { signal: runner.controller.signal });
    if (process.platform === 'win32') await runner.run('powershell.exe', psArgs(`$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${psString(archive)} -DestinationPath ${psString(staging)}`));
    else await runner.run('/usr/bin/ditto', ['-x', '-k', archive, staging]);
    const entries = fs.readdirSync(staging, { withFileTypes: true });
    if (entries.length !== 1 || !entries[0].isDirectory()) throw new Error('GitHub 原始碼壓縮檔結構不正確。');
    fs.renameSync(path.join(staging, entries[0].name), destination);
  } finally {
    fs.rmSync(archive, { force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
function requireFile(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile() || !fs.statSync(file).size) throw new Error(`成品不完整，缺少：${file}`);
}
function verifyExtensions(root, platform, extensions) {
  const roots = platform === 'darwin'
    ? ['arm64', 'x64'].map(a => path.join(root, 'mac/build/work', `root-${a}`, 'MIKU.app/Contents/Resources/ext'))
    : [path.join(root, 'windows/dist/MIKU/ext')];
  for (const extRoot of roots) {
    const actual = fs.existsSync(extRoot) ? fs.readdirSync(extRoot, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort() : [];
    const wanted = extensions.map(e => e.id).sort();
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`套件與勾選內容不符。預期：${wanted.join(', ') || '無'}；實際：${actual.join(', ') || '無'}`);
    for (const ext of extensions) for (const file of ext.files[platform]) requireFile(path.join(extRoot, ext.id, file));
  }
}
async function build({ snapshot, ids, output, platform, runner, stage }) {
  validateCatalog({ schemaVersion: 1, extensions: snapshot.extensions });
  if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some(id => !snapshot.extensions.some(e => e.id === id && e.platforms.includes(platform)))) throw new Error('選擇了無效的套件。');
  const selected = snapshot.extensions.filter(e => ids.includes(e.id));
  stage('check', '檢查編譯環境');
  const checks = await preflight(platform, selected, runner);
  if (checks.some(c => !c.ok)) { const error = new Error('請先完成編譯環境設定，再重試。'); error.checks = checks; throw error; }
  runner.check();
  const job = path.join(output, `MIKU-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`);
  fs.mkdirSync(job, { recursive: true });
  const logFile = path.join(job, 'build.log');
  const originalLog = runner.log;
  let newCache = null;
  runner.log = s => { fs.appendFileSync(logFile, s); originalLog(s); };
  try {
    const root = path.join(job, 'source');
    stage('download', '下載 MIKU 原始碼');
    await downloadSource(snapshot.base, root, runner, text => stage('download', text));
    // This is a fresh downloaded checkout only: remove any bundled extension folders so unchecked modules cannot leak in.
    fs.rmSync(path.join(root, 'Extensions'), { recursive: true, force: true });
    fs.mkdirSync(path.join(root, 'Extensions'));
    for (const ext of selected) {
      await downloadSource(ext, path.join(root, 'Extensions', ext.directory), runner, text => stage('download', text));
      const folder = path.join(root, 'Extensions', ext.directory);
      if (platform === 'darwin') requireFile(path.join(folder, 'miku/pack-mac.sh'));
      else {
        const src = path.join(folder, 'src');
        const projects = fs.existsSync(src) ? fs.readdirSync(src, { withFileTypes: true }).filter(e => e.isDirectory()).flatMap(e => fs.readdirSync(path.join(src, e.name)).filter(f => f.endsWith('.Extension.csproj'))) : [];
        if (!projects.length) throw new Error(`${ext.name} 沒有符合 MIKU 規範的 Windows extension 專案。`);
      }
    }
    // Installed builds carry their actual source revisions; a completed download is not an installed update.
    const installed = installedManifest(snapshot, selected, platform);
    const manifestPath = platform === 'darwin' ? 'mac/app/build-manifest.json' : 'windows/build-manifest.json';
    fs.writeFileSync(path.join(root, manifestPath), JSON.stringify(installed, null, 2));
    // Bootstrap the same small bridge into older MIKU snapshots. Newer upstream code is preserved.
    prepareUpdater(root, platform);
    if (platform === 'darwin') {
      // Reuse downloads only when the recipe is identical (some upstream filenames omit their version).
      const recipe = createHash('sha256').update(fs.readFileSync(path.join(root, 'mac/build/build.sh'))).digest('hex').slice(0, 20);
      const cache = path.join(output, '.miku-cache', recipe);
      fs.mkdirSync(path.dirname(cache), { recursive: true });
      const localDownloads = path.join(root, 'mac/build/downloads');
      if (fs.existsSync(cache)) fs.symlinkSync(cache, localDownloads, 'dir');
      else newCache = { cache, localDownloads };
    }
    stage('build', '正在編譯及打包，首次執行可能需要較長時間');
    if (platform === 'darwin') {
      await runner.run('python3', ['mac/build/sync_wwwroot.py'], root);
      await runner.run('/bin/bash', ['mac/build/build.sh'], root);
    } else await runner.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'windows/make-installer.ps1')], root);
    stage('verify', '確認播放器與所選套件均已放入成品');
    verifyExtensions(root, platform, selected);
    let version, artifact;
    if (platform === 'darwin') {
      version = JSON.parse(fs.readFileSync(path.join(root, 'mac/app/package.json'), 'utf8')).version;
      artifact = path.join(root, 'mac/dist', `MIKU-${version}-mac.pkg`);
      for (const arch of ['arm64', 'x64']) {
        requireFile(path.join(root, 'mac/build/work', `root-${arch}`, 'MIKU.app/Contents/Resources/app/build-manifest.json'));
        await runner.run('/usr/bin/codesign', ['--verify', '--deep', '--strict', path.join(root, 'mac/build/work', `root-${arch}`, 'MIKU.app')], root);
      }
    } else {
      version = fs.readFileSync(path.join(root, 'windows/MIKU.csproj'), 'utf8').match(/<Version>([^<]+)<\/Version>/)?.[1];
      artifact = path.join(root, 'MIKU-Setup', `MIKU-Setup-${version}.exe`);
      requireFile(path.join(root, 'windows/dist/MIKU/MIKU.exe'));
      requireFile(path.join(root, 'windows/dist/MIKU/build-manifest.json'));
    }
    if (!version || !/^[0-9][0-9A-Za-z.+-]*$/.test(version)) throw new Error('播放器版本號不正確。');
    requireFile(artifact); runner.check();
    const result = path.join(job, path.basename(artifact));
    fs.copyFileSync(artifact, result, fs.constants.COPYFILE_EXCL);
    const manifest = { builderVersion: require('./package.json').version, platform, version, createdAt: new Date().toISOString(), base: snapshot.base, extensions: selected.map(({ id, repo, ref, sha }) => ({ id, repo, ref, sha })), artifact: result, job };
    fs.writeFileSync(path.join(job, 'build-manifest.json'), JSON.stringify(manifest, null, 2));
    // Failed/cancelled downloads never become reusable cache entries.
    if (newCache && fs.existsSync(newCache.localDownloads) && !fs.existsSync(newCache.cache)) fs.renameSync(newCache.localDownloads, newCache.cache);
    fs.rmSync(root, { recursive: true, force: true });
    stage('done', '建置完成，可以開啟安裝檔');
    return manifest;
  } catch (e) { e.job = job; throw e; }
  finally { runner.log = originalLog; }
}
module.exports = { BASE, HELP, validateCatalog, validateRelease, selectBuild, extAssetName, extensionRoot, installedExtensions, installExtensions, Runner, latest, latestSource, downloadInstaller, preflight, environment, build, verifyExtensions, downloadSource, psArgs, sameBuild, compareVersions, installedManifest, prepareUpdater };

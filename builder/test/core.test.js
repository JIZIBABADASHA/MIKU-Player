'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const core = require('../core');
const catalog = () => structuredClone(require('../catalog.json'));
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miku-builder-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function put(root, file, text = 'fixture') { const dest = path.join(root, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, text); }

test('catalog rejects traversal, command-like repository data, duplicate IDs and unknown versions', () => {
  core.validateCatalog(catalog());
  for (const mutate of [c => c.extensions[0].directory = '../MIKU', c => c.extensions[0].id = 'CON', c => c.extensions[0].repo = 'https://example.com/x', c => c.extensions[0].files.darwin = ['../evil'], c => c.extensions.push(c.extensions[0]), c => c.schemaVersion = 2]) {
    const value = catalog(); mutate(value); assert.throws(() => core.validateCatalog(value));
  }
});
test('verification refuses a build that silently omitted a selected extension', t => {
  const root = fixture(t), daphne = catalog().extensions.filter(e => e.id === 'daphne');
  assert.throws(() => core.verifyExtensions(root, 'win32', daphne), /不符/);
  put(root, 'windows/dist/MIKU/ext/daphne/Daphne.Extension.dll');
  assert.throws(() => core.verifyExtensions(root, 'win32', daphne), /daphne_core/);
});
test('verification requires both Mac architectures and rejects unchecked modules', t => {
  const root = fixture(t), ext = catalog().extensions[0];
  for (const arch of ['arm64', 'x64']) {
    for (const file of ext.files.darwin) put(root, `mac/build/work/root-${arch}/MIKU.app/Contents/Resources/ext/daphne/${file}`);
    if (arch === 'arm64') assert.throws(() => core.verifyExtensions(root, 'darwin', [ext]), /不符/);
  }
  core.verifyExtensions(root, 'darwin', [ext]);
  assert.throws(() => core.verifyExtensions(root, 'darwin', []), /不符/);
});
test('update comparison includes Release tag, selected modules and platform', () => {
  const installed = { tag: '1.4.3', platform: 'darwin', extensions: [{ id: 'daphne' }] };
  assert.equal(core.sameBuild(installed, structuredClone(installed)), true);
  for (const change of [x => x.tag = '1.4.4', x => x.extensions = [], x => x.platform = 'win32']) {
    const next = structuredClone(installed); change(next); assert.equal(core.sameBuild(installed, next), false);
  }
});
test('source-build comparison still tracks base and Daphne revisions', () => {
  const old = { platform: 'darwin', base: { sha: 'a'.repeat(40) }, extensions: [{ id: 'daphne', sha: 'b'.repeat(40) }] };
  assert.equal(core.sameBuild(old, structuredClone(old)), true);
  const next = structuredClone(old); next.extensions[0].sha = 'c'.repeat(40);
  assert.equal(core.sameBuild(old, next), false);
});
test('newer installed versions are not downgraded to the latest published Release', () => {
  assert.equal(core.compareVersions('1.4.5', '1.4.3'), 1);
  assert.equal(core.compareVersions('1.4.3', '1.4.5'), -1);
  assert.equal(core.compareVersions('1.4.3', '1.4.3'), 0);
  assert.equal(core.compareVersions('unknown', '1.4.3'), null);
});
const releaseOf = (tag, names) => ({ tag_name: tag, draft: false, prerelease: false, assets: names.map(name => ({ name, size: 2048,
  digest: `sha256:${'b'.repeat(64)}`, state: 'uploaded', browser_download_url: `https://github.com/${core.BASE.repo}/releases/download/${tag}/${name}` })) });
test('latest Release offers each module whose prebuilt zip it carries for this computer', () => {
  const tag = '1.4.6';
  const release = releaseOf(tag, [`MIKU-${tag}-mac.pkg`, `MIKU-Setup-${tag}.exe`, `MIKU-ext-daphne-${tag}-win-x64.zip`,
    `MIKU-ext-moodchannels-${tag}-mac-arm64.zip`, `MIKU-ext-daphne-${tag}-mac-x64.zip`]);
  const arm = core.validateRelease(release, 'arm64'), intel = core.validateRelease(release, 'x64');
  assert.equal(core.selectBuild(arm, [], 'win32').asset, `MIKU-Setup-${tag}.exe`);
  assert.deepEqual(core.selectBuild(arm, ['daphne'], 'win32').zips.daphne.asset, `MIKU-ext-daphne-${tag}-win-x64.zip`);
  assert.deepEqual(arm.builds.find(b => b.platform === 'darwin').extensions, ['moodchannels']);
  assert.deepEqual(intel.builds.find(b => b.platform === 'darwin').extensions, ['daphne']);
  assert.throws(() => core.selectBuild(arm, ['daphne'], 'darwin'), /尚未提供 daphne/);
  assert.throws(() => core.selectBuild(arm, ['daphne', 'daphne'], 'win32'), /無效/);
  assert.throws(() => core.selectBuild(arm, ['evil'], 'win32'), /無效/);
});
test('a "v" tag names the modules by the bare version, as the Extensions workflow does', () => {
  const r = core.validateRelease(releaseOf('v1.4.6', ['MIKU-Setup-v1.4.6.exe', 'MIKU-ext-moodchannels-1.4.6-win-x64.zip']), 'x64');
  assert.equal(r.version, '1.4.6');
  assert.deepEqual(r.builds[0].extensions, ['moodchannels']);
});
test('Release files without SHA-256 or from elsewhere are refused', () => {
  const tag = '1.4.6', names = [`MIKU-Setup-${tag}.exe`, `MIKU-ext-daphne-${tag}-win-x64.zip`];
  const missingDigest = releaseOf(tag, names); delete missingDigest.assets[1].digest;
  assert.throws(() => core.validateRelease(missingDigest), /SHA-256/);
  const badUrl = releaseOf(tag, names); badUrl.assets[0].browser_download_url = 'https://example.com/malware.exe';
  assert.throws(() => core.validateRelease(badUrl), /安全下載網址/);
  assert.throws(() => core.validateRelease(releaseOf(tag, names.slice(1))), /沒有相容/);
});
test('verified downloads already in place are reused, the installer only when it is wanted', async t => {
  const output = fixture(t), data = Buffer.alloc(4096, 42), digest = createHash('sha256').update(data).digest('hex');
  const file = asset => ({ asset, sha256: digest, size: data.length, url: 'https://github.com/x' });
  const snapshot = { tag: '1.4.6', version: '1.4.6', base: { repo: core.BASE.repo, ref: '1.4.6', sha: '1.4.6' }, extensions: catalog().extensions,
    builds: [{ platform: 'win32', ...file('MIKU-Setup.exe'), extensions: ['daphne'], zips: { daphne: file('daphne.zip') } }] };
  const job = `MIKU-${snapshot.tag}-win32-daphne`;
  put(output, `${job}/MIKU-Setup.exe`, data); put(output, `${job}/daphne.zip`, data);
  const runner = { controller: new AbortController(), check() {}, run() { throw new Error('Compiler invoked'); } };
  const result = await core.downloadInstaller({ snapshot, ids: ['daphne'], output, platform: 'win32', runner, stage() {} });
  assert.equal(result.artifact, path.join(output, job, 'MIKU-Setup.exe'));
  assert.deepEqual(result.zips, [{ id: 'daphne', file: path.join(output, job, 'daphne.zip') }]);
  const modulesOnly = await core.downloadInstaller({ snapshot, ids: ['daphne'], output, platform: 'win32', runner, stage() {}, installer: false });
  assert.equal(modulesOnly.artifact, null);
});
// stands in for ditto / Expand-Archive: the "zip" is a JSON list of the files it holds
const unzipper = () => ({ controller: new AbortController(), check() {}, async run(_exe, args) {
  const [file, into] = args.slice(-2);
  for (const f of JSON.parse(fs.readFileSync(file, 'utf8'))) put(into, f);
} });
test('modules are swapped into the extension folder; unchosen catalog modules go, other folders stay', async t => {
  const dir = fixture(t), root = path.join(dir, 'ext'), cat = catalog().extensions;
  const daphne = cat[0].files.darwin.map(f => `daphne/${f}`);
  put(dir, 'daphne.zip', JSON.stringify(daphne));
  put(root, 'moodchannels/extension.js', 'old'); put(root, 'someone-elses/extension.js', 'keep'); put(root, 'daphne/old.txt', 'old');
  const ids = await core.installExtensions({ result: { zips: [{ id: 'daphne', file: path.join(dir, 'daphne.zip') }] }, catalog: cat, root, platform: 'darwin', runner: unzipper(), stage() {} });
  assert.deepEqual(ids, ['daphne']);
  assert.ok(fs.existsSync(path.join(root, 'daphne/bin/daphne-helper')));
  assert.ok(!fs.existsSync(path.join(root, 'daphne/old.txt')));
  assert.ok(!fs.existsSync(path.join(root, 'moodchannels')));
  assert.ok(fs.existsSync(path.join(root, 'someone-elses/extension.js')));
  assert.ok(!fs.existsSync(path.join(dir, 'daphne.zip')));
  assert.deepEqual(fs.readdirSync(root).filter(n => n.startsWith('.')), []);
});
test('a module zip that is incomplete or shaped wrong leaves the installed module alone', async t => {
  const dir = fixture(t), root = path.join(dir, 'ext'), cat = catalog().extensions;
  put(root, 'daphne/extension.js', 'old');
  for (const files of [['daphne/extension.js'], ['other/extension.js']]) {
    put(dir, 'daphne.zip', JSON.stringify(files));
    await assert.rejects(core.installExtensions({ result: { zips: [{ id: 'daphne', file: path.join(dir, 'daphne.zip') }] }, catalog: cat, root, platform: 'darwin', runner: unzipper(), stage() {} }), /不完整|結構/);
    assert.equal(fs.readFileSync(path.join(root, 'daphne/extension.js'), 'utf8'), 'old');
  }
});
test('the extension folder is next to MIKU on Windows and in the user MIKU folder on the Mac', () => {
  assert.equal(core.extensionRoot('win32', { LOCALAPPDATA: 'C:\\L' }, 'C:\\U'), path.join('C:\\L', 'Programs', 'MIKU', 'ext'));
  assert.equal(core.extensionRoot('darwin', {}, '/Users/a'), path.join('/Users/a', 'Library', 'Application Support', 'MIKU', 'extensions'));
});
test('runner propagates native failures and records diagnostics', async () => {
  let log = ''; const runner = new core.Runner(s => log += s);
  await assert.rejects(runner.run(process.execPath, ['-e', 'console.error("specific failure");process.exit(7)']), /7/);
  assert.match(log, /specific failure/);
});
test('runner cancels active work and refuses any subsequent command', async () => {
  const runner = new core.Runner(() => {});
  const work = runner.run(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  const rejected = assert.rejects(work, /已取消/);
  await runner.stop(); await rejected;
  assert.throws(() => runner.run(process.execPath, ['--version']), /已取消/);
});
test('fresh Windows source gets a complete updater bridge exactly once', t => {
  const root = fixture(t);
  put(root, 'windows/Host/placeholder');
  put(root, 'windows/Program.cs', 'Application.Run(new Host.MainForm());');
  put(root, 'windows/MIKU.csproj', '<Project></Project>');
  put(root, 'windows/installer.iss', '[Files]\n');
  core.prepareUpdater(root, 'win32'); core.prepareUpdater(root, 'win32');
  assert.equal(fs.readFileSync(path.join(root, 'windows/Program.cs'), 'utf8').match(/BuilderUpdater.Start/g).length, 1);
  assert.match(fs.readFileSync(path.join(root, 'windows/MIKU.csproj'), 'utf8'), /CopyToPublishDirectory/);
  assert.match(fs.readFileSync(path.join(root, 'windows/installer.iss'), 'utf8'), /InstallDelete/);
});
test('fresh Mac source gets updater startup and bundle replacement', t => {
  const root = fixture(t);
  put(root, 'mac/app/main/main.js', '  createWindow();');
  put(root, 'mac/build/make_pkg.py', '    <upgrade-bundle/>');
  core.prepareUpdater(root, 'darwin'); core.prepareUpdater(root, 'darwin');
  assert.equal(fs.readFileSync(path.join(root, 'mac/app/main/main.js'), 'utf8').match(/updater/g).length, 1);
  assert.match(fs.readFileSync(path.join(root, 'mac/build/make_pkg.py'), 'utf8'), /upgrade-bundle><bundle/);
});
test('incompatible future sources stop instead of silently losing automatic updates', t => {
  const root = fixture(t); put(root, 'mac/app/main/main.js', 'differentStartup()');
  assert.throws(() => core.prepareUpdater(root, 'darwin'), /不相容/);
});

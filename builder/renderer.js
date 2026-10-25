'use strict';
const $ = id => document.getElementById(id);
let platform, last, installed, snapshot, busy = false, installedNewer = false;
const selected = () => [...document.querySelectorAll('#extensions input:checked')].map(e => e.value);
function showError(text) { $('error').hidden = !text; $('error').textContent = text || ''; }
function setBusy(value) {
  busy = value;
  for (const id of ['refresh', 'choose', 'build', 'openInstaller', 'openFolder', 'auto']) $(id).disabled = value;
  $('build').disabled = value || installedNewer;
  for (const input of document.querySelectorAll('#extensions input')) input.disabled = value || input.dataset.available === 'false';
  $('cancel').hidden = !value; $('dot').classList.toggle('busy', value);
}
function stage({ id, text }) {
  $('status').textContent = text;
  const steps = ['check', 'download', 'verify', 'done'];
  for (const li of $('steps').children) li.classList.toggle('active', steps.indexOf(li.dataset.step) <= steps.indexOf(id));
}
function versionText(source, previous) {
  if (!source.sha) return `${source.ref} · 尚未檢查`;
  return `${source.ref} · ${!previous ? '尚未安裝' : previous.sha === source.sha ? '與上次安裝相同' : '有更新'}`;
}
function renderExtensions(extensions, keep = [], builds = null) {
  $('extensions').replaceChildren();
  for (const ext of extensions.filter(e => e.platforms.includes(platform))) {
    const label = document.createElement('label'); label.className = 'card extension';
    const available = !builds || builds.some(b => b.platform === platform && b.extensions.includes(ext.id));
    const input = document.createElement('input'); input.type = 'checkbox'; input.value = ext.id; input.checked = available && keep.includes(ext.id); input.disabled = busy || !available; input.dataset.available = String(available);
    const body = document.createElement('div'); body.className = 'grow';
    const row = document.createElement('div'); row.className = 'name-row';
    const name = document.createElement('h2'); name.textContent = ext.name;
    const badge = document.createElement('span'); badge.className = 'ext-badge'; badge.textContent = available ? '選用擴充' : '此 Release 尚未提供'; row.append(name, badge);
    const desc = document.createElement('p'); desc.textContent = ext.description;
    const ver = document.createElement('small'); ver.textContent = available ? versionText(ext, last?.extensions?.find(e => e.id === ext.id)) : '這個 Release 還沒有它的已編譯版本';
    const source = document.createElement('div'); source.className = 'source'; source.textContent = `${ext.repo} · ${ext.ref}`;
    body.append(row, desc, ver, source); label.append(input, body); $('extensions').append(label);
  }
}
function renderSnapshot(value) {
  snapshot = value;
  const keep = selected();
  installedNewer = installed && /^\d+(?:\.\d+){1,3}$/.test(installed.version) && /^\d+(?:\.\d+){1,3}$/.test(value.version) &&
    installed.version.split('.').map(Number).some((n, i, all) => n > Number(value.version.split('.')[i] || 0) && all.slice(0, i).every((x, j) => x === Number(value.version.split('.')[j] || 0)));
  $('coreVersion').textContent = installedNewer ? `GitHub ${value.version} · 本機已安裝較新的 ${installed.version}` : `MIKU ${value.version} · ${versionText(value.base, last?.base)}`;
  $('build').disabled = busy || installedNewer;
  $('catalogNotice').textContent = `GitHub 最新 Release：${value.tag}`;
  renderExtensions(value.extensions, keep, value.builds);
}
function renderResult(result, previous = false) {
  if (!result) return;
  $('result').hidden = false;
  $('resultTitle').textContent = `${result.installed ? '已安裝' : previous ? '上次下載' : '下載完成'} · MIKU ${result.version}`;
  $('resultInfo').textContent = `套件：${result.extensions.map(e => e.id).join('、') || '只有播放器本體'} · ${new Date(result.createdAt).toLocaleString()}`;
  $('openInstaller').hidden = !result.artifact;
  $('openFolder').textContent = result.installed ? '顯示擴充資料夾' : '顯示資料夾';
}
async function invoke(fn) {
  showError('');
  try {
    const reply = await fn();
    if (!reply.ok) {
      showError(reply.error);
      if (reply.job) $('failureFolder').hidden = false;
      $('status').textContent = reply.error === '已取消。' ? '已停止，可重新開始' : '未完成，請查看下方說明';
      return null;
    }
    return reply.value;
  } catch (e) { showError(e.message); return null; }
}
window.builder.onEvent(({ type, value }) => {
  if (type === 'busy') setBusy(value);
  if (type === 'stage') stage(value);
  if (type === 'snapshot') renderSnapshot(value);
  if (type === 'notice') showError(value);
  if (type === 'result') { last = value; renderResult(value); stage({ id: 'done', text: '更新已準備好，請開啟安裝檔' }); }
  if (type === 'installed') { last = value; renderResult(value); }
  if (type === 'backgroundError') { showError(value.message); if (value.job) $('failureFolder').hidden = false; $('status').textContent = '自動更新需要處理'; }
  if (type === 'log') { $('log').textContent = ($('log').textContent + value).slice(-100000); $('log').scrollTop = $('log').scrollHeight; }
});
$('refresh').onclick = () => invoke(() => window.builder.refresh());
$('choose').onclick = async () => { const value = await invoke(() => window.builder.choose()); if (value) $('output').textContent = value; };
$('build').onclick = async () => {
  $('log').textContent = ''; $('result').hidden = true; $('failureFolder').hidden = true;
  const result = await invoke(() => window.builder.build(selected()));
  if (result) { last = result; renderResult(result); if (snapshot) renderSnapshot(snapshot); }
};
$('cancel').onclick = () => invoke(() => window.builder.cancel());
$('openInstaller').onclick = () => invoke(() => window.builder.open('installer'));
$('openFolder').onclick = () => invoke(() => window.builder.open('folder'));
$('failureFolder').onclick = () => invoke(() => window.builder.open('failure'));
$('auto').onchange = async () => { const enabled = $('auto').checked; const result = await invoke(() => window.builder.auto(enabled)); if (result === null) $('auto').checked = !enabled; };
(async () => {
  const value = await invoke(() => window.builder.initial());
  if (!value) return;
  platform = value.platform; last = value.last; installed = value.installed;
  $('auto').checked = value.autoUpdate;
  $('platform').textContent = platform === 'darwin' ? `macOS · ${value.arch === 'arm64' ? 'Apple Silicon' : 'Intel'}` : 'Windows · x64';
  $('output').textContent = value.output;
  $('version').textContent = `Builder ${value.version}`;
  $('requirements').textContent = '只下載已編譯的安裝檔；不在使用者電腦安裝編譯工具。安裝完成後會清理下載的安裝檔。';
  renderExtensions(value.catalog.extensions, last?.extensions?.map(e => e.id) || []);
  renderResult(last, true);
  if (!value.background) await invoke(() => window.builder.refresh());
})();

'use strict';
// Unpacked Electron. Real Mac host plus Windows renderer with an isolated offline preview host.
const { app, BrowserWindow, session } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert/strict');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miku-lightweight-'));
const testApp = path.join(root, 'app');
fs.cpSync(process.env.MIKU_TEST_APP || path.resolve(__dirname, '../app'), testApp, { recursive: true });
for (const key of ['userData', 'sessionData', 'cache', 'logs']) {
  const dir = path.join(root, key); fs.mkdirSync(dir); app.setPath(key, dir);
}
app.setName('MIKU Lightweight Test'); app.commandLine.appendSwitch('mute-audio');
app.on('browser-window-created', (_e, win) => { win.show = () => win.showInactive(); });
app.on('will-quit', () => { if (process.exitCode) app.exit(process.exitCode); });
fs.writeFileSync(path.join(root, 'userData/settings.json'), JSON.stringify({
  folders: [], onlineArt: false, onlineLyrics: false, artistImages: false, remoteEnabled: false,
  outputMode: 'coreaudio', ui: { lang: 'zh-Hant', theme: 'glass' },
}));
const tracks = Array.from({ length: 32 }, (_, i) => ({ id: 'fixture-' + i, path: path.join(root, i + '.wav'),
  title: 'Fixture ' + i, artist: 'MIKU test', albumArtist: 'MIKU test', album: 'Album ' + i,
  codec: 'WAV', sampleRate: 48000, bits: 24, channels: 2, duration: 12, trackNo: 1, discNo: 1, mtime: 1 }));
fs.writeFileSync(path.join(root, 'userData/library.json'), JSON.stringify({ version: 1, tracks, folderArt: {} }));
const winRoot = path.join(root, 'windows');
fs.cpSync(path.resolve(__dirname, '../../windows/wwwroot'), winRoot, { recursive: true });
const winHtml = path.join(winRoot, 'index.html');
const previewHost = `<script src="mock.js"></script><script>
(() => {
  const call = Mock.call.bind(Mock);
  Mock.call = (method, args, emit) => {
    const ui = JSON.parse(localStorage.getItem('test.windows.ui') || '{}');
    if (method === 'ready') return call(method, args, emit).then(init => {
      init.settings.ui = { theme: 'glass', lang: 'zh-Hant', ...ui }; return init;
    });
    if (method === 'ui') { ui[args.key] = args.value; localStorage.setItem('test.windows.ui', JSON.stringify(ui)); return Promise.resolve(null); }
    return call(method, args, emit);
  };
})();</script><script>App.start();</script>`;
fs.writeFileSync(winHtml, fs.readFileSync(winHtml, 'utf8').replace('<script>App.start();</script>', previewHost));
require(path.join(testApp, 'main/main.js'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await delay(30); }
  throw new Error('Timed out: ' + label);
}
const report = { checks: [] };
function check(ok, label) { report.checks.push({ label, passed: !!ok }); assert.ok(ok, label); }
const art = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#397a91"/><circle cx="200" cy="200" r="100" fill="#e6aab7"/></svg>').toString('base64');
async function renderer(platform, win) {
  const js = code => win.webContents.executeJavaScript(code, true);
  win.webContents.setBackgroundThrottling(false);
  await until(() => js('typeof PageEffects !== "undefined" && Lib.tracks.length > 0 && !!Router.cur.name'), platform + ' startup');
  await js(`App.settings.folders = ['test fixtures'];
    window.effectCalls = []; const effectCall = Host.call.bind(Host);
    Host.call = (method, args) => { effectCalls.push({ method, args }); return effectCall(method, args); };
    window.testCover = ${JSON.stringify(art)};
    window.addTestArt = box => { box.querySelectorAll('img').forEach(i => i.remove());
      const img = new Image(); img.className = 'ok'; img.src = testCover; box.append(img); };
    go('#/settings/look');`);
  const audio = 'JSON.stringify(Object.fromEntries(["outputMode","deviceId","volumeMode","volumeDb","replayGain","dsp","upsampling","autoSampleRate"].map(k => [k, App.settings[k]])))';
  const originalAudio = await js(audio);
  check(await js('document.querySelectorAll(".lite-settings").length === 1 && document.querySelector(".lite-options").hidden && !PageEffects.enabled'), platform + ': opt-in default');
  await js('document.querySelector("[data-effect=lightweight]").focus(); document.activeElement.dispatchEvent(new KeyboardEvent("keydown", {key:" ", code:"Space", bubbles:true, cancelable:true}));');
  check(await js('!effectCalls.some(c => c.method === "toggle")'), platform + ': switch keyboard input does not toggle playback');
  await js('document.querySelector("[data-effect=lightweight]").click()');
  check(await js('PageEffects.kinds.every(k => PageEffects.reduced(k)) && !document.querySelector(".lite-options").hidden && document.querySelectorAll(".lite-options [role=switch]").length === 7'), platform + ': master exposes seven active reductions');
  check(await js('getComputedStyle(document.querySelector(".sect")).backdropFilter === "none" && getComputedStyle(document.querySelector("#theme-bg .orb")).display === "none"'), platform + ': glass blur removed');
  const variants = [
    { quality: 'bitperfect', sourceBits: 16, sourceRate: 44100, codec: 'FLAC' },
    { quality: 'bitperfect', sourceBits: 24, sourceRate: 96000, codec: 'FLAC' },
    { quality: 'bitperfect', sourceBits: 1, sourceRate: 5644800, codec: 'DSF', dsd: true, dsdLabel: 'DSD128', dop: true },
    { quality: 'low', sourceBits: 0, sourceRate: 48000, codec: 'MP3', lossy: true },
    { quality: 'enhanced', sourceBits: 24, sourceRate: 48000, codec: 'FLAC', dspActive: true, dspSummary: 'EQ' },
  ];
  for (const variant of variants) {
    await js(`Popover.close(); App.state.signal = ${JSON.stringify({ outputRate: 96000, outputFormat: '32-bit PCM', mode: 'Test output', volumeMode: 'fixed', ...variant })};
      App.renderSignal(); document.body.classList.remove('paused'); SignalPop.toggle(document.querySelector('#b-sig'));`);
    await delay(80);
    const signal = await js(`({ stages: document.querySelectorAll('.sigpop .stage').length,
      badge: document.querySelector('#b-sig').getAnimations({subtree:true}).map(a => a.animationName),
      popup: document.querySelector('.sigpop').getAnimations({subtree:true}).map(a => ({name:a.animationName, target:a.effect.target.className, pseudo:a.effect.pseudoElement})) })`);
    if (!signal.stages || signal.badge.length || signal.popup.length) console.error(platform, variant.codec, signal);
    check(signal.stages && signal.badge.length === 0 && signal.popup.length === 0, platform + ': static signal information ' + variant.codec + '/' + variant.quality);
  }
  await js('Popover.close(); go("#/settings/look"); document.querySelector("[data-effect=lite_signal]").click(); App.renderSignal(); document.body.classList.remove("paused")');
  await delay(100);
  check(await js('!PageEffects.reduced("signal") && PageEffects.reduced("page") && document.querySelector("#b-sig").getAnimations({subtree:true}).some(a => a.effect.getTiming().iterations === Infinity)'), platform + ': signal option independent of page option');
  await js('document.querySelector("[data-effect=lightweight]").click()');
  check(await js('!PageEffects.enabled && !PageEffects.kinds.some(k => document.documentElement.classList.contains("lite-"+k)) && App.settings.ui.lite_signal === "0"'), platform + ': master off restores effects and keeps choices');
  await js('document.querySelector("[data-effect=lightweight]").click(); document.querySelector("[data-effect=lite_signal]").click();');

  await js('Drawer.show("queue")');
  check(await js('getComputedStyle(document.querySelector("#queue")).visibility === "visible" && getComputedStyle(document.querySelector("#queue")).transitionDuration === "0s"'), platform + ': queue panel opens without transition');
  await js('Drawer.close()'); await delay(100);
  check(await js('getComputedStyle(document.querySelector("#queue")).visibility === "hidden"'), platform + ': queue panel closes');
  await js('App.state.trackId = Lib.tracks[0].id; NowPlaying.show()'); await delay(100);
  check(await js('getComputedStyle(document.querySelector("#np")).visibility === "visible" && getComputedStyle(document.querySelector("#np")).transitionDuration === "0s"'), platform + ': now-playing panel opens');
  await js('NowPlaying.hide()'); await delay(100);
  check(await js('getComputedStyle(document.querySelector("#np")).visibility === "hidden"'), platform + ': now-playing panel closes');
  if (platform === 'Windows') check(await js('SmoothScroll.enabled === false'), platform + ': wheel inertia disabled');
  await js('go("#/albums")');
  await until(() => js('!!document.querySelector(".card [data-album]")'), platform + ' album grid');
  const album = await js('document.querySelector(".card [data-album]").dataset.album');
  await js(`addTestArt(document.querySelector('[data-album="${album}"]')); Flip.capture(${JSON.stringify(album)}, document.querySelector('[data-album="${album}"]')); go(${JSON.stringify('#/album/' + album)});`);
  await delay(80);
  check(await js('!Flip.from && !document.querySelector(".flip-clip") && document.querySelector(".hero.album .cover").style.transform === ""'), platform + ': album cover opens directly');
  await js('go("#/albums")'); await delay(100);
  check(await js('!document.querySelector(".flip-clip") && !Flip.back'), platform + ': album cover returns directly');

  // The normal flight is restored, and enabling lightweight mode mid-flight cleans up the real cover.
  await js('PageEffects.set("lightweight", false); Theme.set("glass"); go("#/albums")');
  await until(() => js(`!!document.querySelector('[data-album="${album}"]')`), platform + ' restored grid');
  await js(`addTestArt(document.querySelector('[data-album="${album}"]')); Flip.capture(${JSON.stringify(album)}, document.querySelector('[data-album="${album}"]')); go(${JSON.stringify('#/album/' + album)});`);
  await until(() => js('document.querySelector(".hero.album .cover").getAnimations().length > 0'), platform + ' restored cover flight');
  await js('PageEffects.set("lightweight", true)'); await delay(60);
  check(await js('document.querySelector(".hero.album .cover").style.transform === "" && [...(PageEffects.active.get("album") || [])].length === 0'), platform + ': changing mode cleans up a running cover flight');
  await js(`Theme.set('vinyl'); Router.render(true, 'none')`); await delay(100);
  check(await js('Vinyl.deck && !Vinyl.deck.spin && !document.querySelector(".vrec-fly") && !Vinyl.deck.rec.getAnimations().length'), platform + ': turntable stays static');
  await js('PageEffects.set("lite_vinyl", false)'); await delay(100);
  check(await js('Vinyl.deck.spin?.playState === "running" && PageEffects.reduced("album")'), platform + ': record rotation can be enabled independently');
  await js('PageEffects.set("lite_vinyl", true)');
  check(await js('!Vinyl.deck.spin && !Vinyl.deck.rec.getAnimations().length'), platform + ': running record rotation is cancelled');
  await js('go("#/settings/look")');
  await until(() => js('!!document.querySelector(".lite-settings")'), platform + ' settings returned');
  await js('Theme.apply("glass")');
  check(await js(audio) === originalAudio, platform + ': audio settings untouched');
  check(await js('effectCalls.filter(c => ["settings","dsp","volume","play","seek"].includes(c.method)).length === 0'), platform + ': appearance switches send no audio changes');
  for (const theme of ['miku', 'night', 'wood', 'glass', 'flat', 'neon', 'washi', 'vinyl']) {
    await js(`Theme.set(${JSON.stringify(theme)})`);
    check(await js('getComputedStyle(document.querySelector(".lite-settings")).display !== "none" && document.querySelector("[data-effect=lightweight]").getBoundingClientRect().width > 0'), platform + ': settings visible in ' + theme);
  }
  await js('Theme.set("glass"); document.querySelector("#content").scrollTop = 0;');
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await delay(1000);
  check(await js('Router.cur.name === "settings" && Router.cur.arg === "look" && document.documentElement.dataset.theme === "glass"'), platform + ': preview shows appearance settings');
  fs.writeFileSync(path.join(root, platform.toLowerCase() + '-lightweight.png'), (await win.webContents.capturePage()).toPNG());
  // Readback after reload must come from the host's saved UI dictionary, not just the early cache.
  await js('localStorage.removeItem(PageEffects.cacheKey)'); await delay(400);
  win.webContents.reload();
  await until(() => js('typeof PageEffects !== "undefined" && PageEffects.enabled && Lib.tracks.length > 0 && !!Router.cur.name'), platform + ' persisted reload');
  check(await js('PageEffects.kinds.every(k => PageEffects.reduced(k))'), platform + ': persisted master and details after reload');
}
const watchdog = setTimeout(() => { console.error('Lightweight UI test timed out; ' + root); app.exit(1); }, 120000);
app.whenReady().then(async () => {
  try {
    app.setActivationPolicy('accessory');
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_d, cb) => cb({ cancel: true }));
    let mac;
    await until(() => { mac = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('miku://app/')); return mac; }, 'Mac window');
    await renderer('Mac', mac);
    const win = new BrowserWindow({ width: 1320, height: 1000, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
    win.showInactive(); await win.loadFile(winHtml); await renderer('Windows', win);
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'userData/settings.json')));
    check(saved.ui.lightweight === '1' && saved.ui.lite_vinyl === '1' && saved.outputMode === 'coreaudio', 'Mac host saves UI choices without changing output');
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    console.log('Lightweight UI checks passed: ' + report.checks.length + ' (Mac host and Windows renderer).');
    console.log('Lightweight UI previews and report: ' + root);
    clearTimeout(watchdog); win.destroy(); app.quit();
  } catch (e) {
    console.error(e.stack); console.error('Lightweight UI profile: ' + root);
    console.error(JSON.stringify(report, null, 2)); process.exitCode = 1; clearTimeout(watchdog); app.quit();
  }
});

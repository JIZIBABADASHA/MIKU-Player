'use strict';
// electron mac/tests/native-audio-ui.js. Uses an isolated profile and all-zero WAV files.
const { app, BrowserWindow, session, webContents } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert/strict');
const source = path.resolve(__dirname, '../app'), root = fs.mkdtempSync(path.join(os.tmpdir(), 'miku-native-ui-'));
const testApp = path.join(root, 'app'); fs.cpSync(source, testApp, { recursive: true });
process.env.MIKU_AUDIO_HELPER ||= path.resolve(__dirname, '../build/native/miku-audio-' + process.arch);
for (const key of ['userData', 'sessionData', 'cache', 'logs']) { const dir = path.join(root, key); fs.mkdirSync(dir); app.setPath(key, dir); }
app.setName('MIKU Native Audio Test'); app.commandLine.appendSwitch('mute-audio');
app.on('will-quit', () => { if (process.exitCode) app.exit(process.exitCode); });
app.on('browser-window-created', (_e, win) => { win.show = () => win.showInactive(); });
const tracks = [[48000, 24], [48000, 16], [96000, 24]].map(([rate, bits], i) => {
  const bytes = bits / 8, frames = rate * 12, data = Buffer.alloc(44 + frames * 2 * bytes);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2 * bytes, 28);
  data.writeUInt16LE(2 * bytes, 32); data.writeUInt16LE(bits, 34); data.write('data', 36); data.writeUInt32LE(data.length - 44, 40);
  const file = path.join(root, i + '.wav'); fs.writeFileSync(file, data);
  return { id: 'native-' + i, path: file, title: 'Native PCM ' + (i + 1), artist: 'MIKU test', albumArtist: 'MIKU test', album: 'Native Audio Test',
    codec: 'WAV', sampleRate: rate, bits, channels: 2, duration: 12, trackNo: i + 1, discNo: 1, mtime: 1 };
});
fs.writeFileSync(path.join(root, 'userData/settings.json'), JSON.stringify({ folders: [], onlineArt: false, onlineLyrics: false, artistImages: false,
  remoteEnabled: false, dsp: { enabled: true }, replayGain: 'album', volumeMode: 'digital', volumeDb: -20, ui: { lang: 'zh-Hant', theme: 'glass' } }));
fs.writeFileSync(path.join(root, 'userData/library.json'), JSON.stringify({ version: 1, tracks, folderArt: {} }));
require(path.join(testApp, 'main/main.js'));
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await delay(60); } throw new Error('Timed out: ' + label); }
const watchdog = setTimeout(() => { console.error('Native UI test timed out; profile ' + root); app.quit(); }, 100000);
app.whenReady().then(async () => {
  let ui, js;
  try {
    app.setActivationPolicy('accessory');
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_d, cb) => cb({ cancel: true }));
    await until(() => { ui = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('miku://app/')); return ui; }, 'window');
    js = code => ui.webContents.executeJavaScript(code);
    await until(() => js('typeof App !== "undefined" && Lib.tracks.length === 3 && !!Router.cur.name'), 'startup');
    await js('history.replaceState({}, "", "#/settings/audio"); Router.render(false, "none");');
    await until(() => js('[...document.querySelectorAll("button")].some(b => b.textContent === "套用 Bit-perfect 設定")'), 'bit-perfect settings');
    assert(await js('Host.call("devices").then(d => d.nativeAvailable)'));
    await js('[...document.querySelectorAll("button")].find(b => b.textContent === "套用 Bit-perfect 設定").click();');
    await until(() => js('App.settings.outputMode === "coreaudio-exclusive" && App.settings.volumeMode === "fixed" && !App.settings.dsp.enabled && App.settings.replayGain === "off"'), 'quick settings');
    await delay(500);
    assert.equal(await js('document.querySelectorAll(".settings").length'), 1, 'settings must not nest after changing mode');
    let dac;
    await until(async () => {
      const list = (await js('Host.call("devices")')).devices;
      const wanted = process.env.MIKU_TEST_DAC;
      dac = list.find(d => !d.isDefault && (wanted ? d.name.includes(wanted) : d.transport === 'usb' && d.exclusiveSupported));
      return !!dac;
    }, 'USB DAC in the device inventory (set MIKU_TEST_DAC=<name>)');
    await js('Settings.set(' + JSON.stringify({ deviceId: dac.id }) + ').then(() => Outputs.refresh()).then(() => Router.render(false, "none"))');
    await js('Host.call("play", { ids: ["native-0", "native-1", "native-2"], start: 0, shuffle: false })');
    await until(() => js('App.state.playing && App.state.signal?.quality === "bitperfect" && App.state.signal.outputRate === 48000'), 'native 48 kHz bit-perfect');
    assert(await js('App.state.signal.exclusive && App.state.signal.device === ' + JSON.stringify(dac.name) + ' && App.state.signal.sourceBits === 24'));
    ui.webContents.setBackgroundThrottling(false);
    await js('SignalPop.toggle(document.querySelector(".sig"))'); await delay(700);
    assert(await js('document.querySelector(".sigpop").textContent.includes("DAC 格式")'));
    console.log('Bit-perfect popup: ' + JSON.stringify(await js('({ rect: document.querySelector(".sigpop").getBoundingClientRect().toJSON(), opacity: getComputedStyle(document.querySelector(".sigpop")).opacity })')));
    fs.writeFileSync(path.join(root, 'bit-perfect.png'), (await ui.webContents.capturePage()).toPNG());
    await js('Popover.close(); Host.call("seek", { pos: 11.3 })');
    await until(() => js('App.state.trackId === "native-1" && App.state.playing && App.state.signal.sourceBits === 16'), 'same-rate gapless handoff');
    assert.equal(await js('App.state.signal.quality'), 'bitperfect');
    await js('Host.call("seek", { pos: 11.3 })');
    await until(() => js('App.state.trackId === "native-2" && App.state.playing && App.state.signal.outputRate === 96000'), 'cross-rate native handoff');
    assert.equal(await js('App.state.signal.quality'), 'bitperfect');
    await js('Host.call("toggle")'); await until(() => js('!App.state.playing'), 'pause');
    await js('Host.call("seek", { pos: 2 })'); await until(() => js('App.state.loaded && !App.state.playing && Math.abs(App.state.pos - 2) < 0.1'), 'paused seek');
    await js('Host.call("settings", { volumeMode: "digital", volumeDb: -3 })');
    await until(() => js('App.state.signal?.quality === "enhanced"'), 'digital gain label');
    await js('Host.call("settings", { volumeMode: "fixed" })'); await until(() => js('App.state.signal?.quality === "bitperfect"'), 'unity label restored');
    await js('Host.call("dsp", { enabled: true, eqOn: true, autoPreamp: false, preampDb: -4, bands: [] })');
    await until(() => js('App.state.signal?.quality === "enhanced" && App.state.signal.dspSummary.includes("前級增益")'), 'DSP label');
    await js('Host.call("dsp", { enabled: false })'); await until(() => js('App.state.signal?.quality === "bitperfect"'), 'DSP bypass restored');
    // YouTube playback releases native ownership before starting its shared browser output.
    await js('Host.call("yt.show", { x: 0, y: 0, w: 100, h: 100 })');
    const panel = webContents.getAllWebContents().find(w => w !== ui.webContents);
    const file = path.join(root, 'panel.html'); fs.writeFileSync(file, '<video src="0.wav"></video><ytmusic-player-bar><div class="title">Panel test</div><div class="byline">MIKU test</div></ytmusic-player-bar>');
    await panel.loadFile(file); await panel.executeJavaScript('document.querySelector("video").play()', true);
    await until(() => panel.executeJavaScript('document.querySelector("video").currentTime > 0.2'), 'YouTube shared playback');
    // This RPC is ordered behind the helper's stop/restore command, so wait for actual completion.
    const released = (await js('Host.call("devices")')).caps;
    assert.equal(released.ownerPid, -1); assert.equal(released.rate, dac.rate);
    assert.equal(released.physicalFormat, dac.physicalFormat); assert.equal(released.virtualFormat, dac.virtualFormat);
    await panel.executeJavaScript('document.querySelector("video").pause()');
    await js('Host.call("yt.hide")');
    // Shared mode is native too: same DAC, no hog, rate still matched, never labelled bit-perfect.
    await js('Host.call("settings", { outputMode: "coreaudio" })');
    await js('Host.call("play", { ids: ["native-2"], start: 0, shuffle: false })');
    await until(() => js('App.state.playing && App.state.signal?.mode === "Core Audio 共享" && App.state.signal.outputRate === 96000'), 'native shared playback');
    assert.notEqual(await js('App.state.signal.quality'), 'bitperfect');
    assert.equal((await js('Host.call("devices")')).caps.ownerPid, -1, 'shared mode must not take hog mode');
    assert(!BrowserWindow.getAllWindows().some(w => w.webContents.getURL().startsWith('miku://engine/')), 'shared mode must not use the browser engine');
    await js('Host.call("stop")');
    console.log('Native UI checks passed: quick settings, actual 48/96 kHz bit-perfect, gapless, pause/seek, gain/DSP labels, YouTube DAC release, native shared mode');
    console.log('Native UI preview: ' + path.join(root, 'bit-perfect.png')); clearTimeout(watchdog); app.quit();
  } catch (e) {
    console.error(e.stack); console.error('Native UI profile: ' + root);
    try { if (js) console.error(JSON.stringify(await js('App.state'))); } catch { }
    process.exitCode = 1; clearTimeout(watchdog); app.quit();
  }
});

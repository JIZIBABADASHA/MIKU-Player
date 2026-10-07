'use strict';
// Run with an unpacked Electron binary: electron mac/tests/power-regression.js
// All settings, media and caches are isolated in a temporary directory. No user library is loaded.
const { app, BrowserWindow, session, ipcMain, webContents } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert/strict');
const observeOnly = process.argv.includes('--baseline');
const root = process.env.MIKU_TEST_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'miku-power-regression-'));
const source = process.env.MIKU_TEST_APP || path.resolve(__dirname, '../app');
const testApp = path.join(root, 'app');
fs.mkdirSync(root, { recursive: true });
fs.cpSync(source, testApp, { recursive: true });
for (const key of ['userData', 'sessionData', 'cache', 'logs']) {
  const dir = path.join(root, key); fs.mkdirSync(dir, { recursive: true }); app.setPath(key, dir);
}
app.setName('MIKU Power Regression');
app.commandLine.appendSwitch('mute-audio');
app.on('browser-window-created', (_e, win) => { win.show = () => win.showInactive(); });

function wav(file, seconds) {
  const frames = Math.round(48000 * seconds), data = Buffer.alloc(44 + frames * 4);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22);
  data.writeUInt32LE(48000, 24); data.writeUInt32LE(192000, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(8192 * Math.sin(2 * Math.PI * 440 * i / 48000));
    data.writeInt16LE(v, 44 + i * 4); data.writeInt16LE(v, 46 + i * 4);
  }
  fs.writeFileSync(file, data);
}
const tracks = ['a', 'b'].map((id, i) => {
  const file = path.join(root, id + '.wav'); wav(file, 12);
  return { id, path: file, title: 'Power test ' + id, artist: 'MIKU test', albumArtist: 'MIKU test', album: 'Test album',
    codec: 'WAV', sampleRate: 48000, bits: 16, channels: 2, duration: 12, trackNo: i + 1, discNo: 1, year: 2026, mtime: 1 };
});
fs.writeFileSync(path.join(root, 'userData', 'settings.json'), JSON.stringify({
  folders: [], onlineArt: false, onlineLyrics: false, artistImages: false, remoteEnabled: false,
  gapless: true, repeat: 'off', autoContinue: 'off', volumeMode: 'digital', volumeDb: -20, ui: { lang: 'zh-Hant', theme: 'glass' },
}));
const fixtures = [...tracks, ...Array.from({ length: 32 }, (_, i) => ({
  ...tracks[0], id: 'fixture-' + i, title: 'Fixture ' + i, album: 'Album ' + i, artist: 'Artist ' + Math.floor(i / 4), albumArtist: 'Artist ' + Math.floor(i / 4),
}))];
fs.writeFileSync(path.join(root, 'userData', 'library.json'), JSON.stringify({ version: 1, tracks: fixtures, folderArt: {} }));

// Track resources owned by the live UI, without retaining discarded observers in a global registry.
const instrument = `(() => {
  const RO = ResizeObserver;
  window.ResizeObserver = class extends RO {
    constructor(fn) { super(fn); this.powerTargets = new Set(); }
    observe(el, opts) { super.observe(el, opts); this.powerTargets.add(el); }
    unobserve(el) { super.unobserve(el); this.powerTargets.delete(el); }
    disconnect() { super.disconnect(); this.powerTargets.clear(); }
  };
  const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
  const cols = new Set();
  EventTarget.prototype.addEventListener = function(type, fn, opts) {
    if (this === window && type === 'gridcols') cols.add(fn);
    return add.call(this, type, fn, opts);
  };
  EventTarget.prototype.removeEventListener = function(type, fn, opts) {
    if (this === window && type === 'gridcols') cols.delete(fn);
    return remove.call(this, type, fn, opts);
  };
  window.powerStats = { frames: 0, cols };
})();`;
const html = path.join(testApp, 'wwwroot/index.html');
fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replace('<head>', '<head><script>' + instrument + '</script>'));

require(path.join(testApp, 'main/main.js'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await delay(50); }
  throw new Error('Timed out: ' + label);
}
const report = { mode: observeOnly ? 'before' : 'after', checks: [] };
function check(value, label) { report.checks.push({ label, passed: !!value }); if (!observeOnly) assert.ok(value, label); }
const watchdog = setTimeout(() => { console.error('Power regression timed out'); app.exit(1); }, 90000);

app.whenReady().then(async () => {
  try {
    app.setActivationPolicy('accessory');
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_d, cb) => cb({ cancel: true }));
    let ui, engine;
    await until(() => {
      const windows = BrowserWindow.getAllWindows();
      ui = windows.find(w => w.webContents.getURL().startsWith('miku://app/'));
      engine = windows.find(w => w.webContents.getURL().startsWith('miku://engine/'));
      return ui && engine;
    }, 'windows');
    const js = code => ui.webContents.executeJavaScript(code);
    const audio = code => engine.webContents.executeJavaScript(code);
    await until(() => js('typeof App !== "undefined" && !!App.frameEls && Lib.tracks.length === 34 && !!Router.cur.name'), 'UI startup');
    await until(() => audio('typeof dsp !== "undefined" && !!dsp'), 'DSP startup');
    await js('const frame = App.frame; App.frame = function(...args) { powerStats.frames++; return frame.apply(this, args); }; void 0;');
    await audio('globalThis.powerMessages = 0; const handler = dsp.port.onmessage; dsp.port.onmessage = e => { powerMessages++; handler(e); }; void 0;');
    // Render the real library views while the backend remains unconfigured and never starts a folder scan.
    await js('App.settings.folders = ["test fixture"]; Router.render(false, "none");');
    if (process.argv.includes('--visibility-only')) {
      const events = [];
      for (const event of ['hide', 'show', 'focus', 'blur']) ui.on(event, () => events.push({ event, visible: ui.isVisible() }));
      app.on('activate', () => events.push({ event: 'activate', visible: ui.isVisible() }));
      await delay(1500);
      const before = { native: ui.isVisible(), page: await js('({ hidden: document.hidden, visible: App.uiVisible, raf: App.frameRaf })') };
      ui.hide(); await delay(1500);
      const after = { native: ui.isVisible(), page: await js('({ hidden: document.hidden, visible: App.uiVisible, raf: App.frameRaf })') };
      console.log(JSON.stringify({ before, after, events }, null, 2)); clearTimeout(watchdog); app.exit(0); return;
    }
    let statuses = 0;
    ipcMain.on('eng', (e, m) => { if (e.sender === engine.webContents && m.e === 'status') statuses++; });
    async function quiet(label) {
      await delay(300);
      const start = await audio('({ time: ctx.currentTime, messages: powerMessages, state: ctx.state })');
      const frames = await js('powerStats.frames'); statuses = 0; app.getAppMetrics();
      await delay(2000);
      const end = await audio('({ time: ctx.currentTime, messages: powerMessages, state: ctx.state })');
      const frameDelta = await js('powerStats.frames') - frames;
      const cpu = app.getAppMetrics().reduce((n, m) => n + m.cpu.percentCPUUsage, 0);
      report[label] = { state: end.state, audioTimeDelta: end.time - start.time, meterMessages: end.messages - start.messages,
        uiFrames: frameDelta, statuses, totalCPUPercent: +cpu.toFixed(2) };
      check(end.state === 'suspended' && end.time === start.time, label + ': audio hardware suspended');
      check(end.messages === start.messages, label + ': no DSP metering work');
      check(frameDelta <= 3, label + ': no continuous visual loop');
    }
    await quiet('startupIdle');
    check(await js('document.getAnimations().filter(a => a.effect.getTiming().iterations === Infinity && a.playState === "running").length === 0'), 'paused glass decorations stop');

    const resources = () => js('({ cols: powerStats.cols.size, artTargets: ArtSharp.ro.powerTargets.size, detached: [...ArtSharp.ro.powerTargets].filter(n => !n.isConnected).length })');
    async function pages(n) {
      for (let i = 0; i < n; i++) {
        for (const route of ['albums', 'artists', 'tracks', 'settings', 'home']) {
          await js(`history.replaceState({}, '', '#/${route}'); Router.render(false, 'none');`);
        }
      }
      await delay(750);
    }
    await pages(2); const warm = await resources();
    check(warm.cols > 0 && warm.artTargets > 0, 'page stress exercises library listeners and art observers');
    await pages(12); const later = await resources();
    report.pageStress = { transitions: 60, warm, later };
    check(later.cols === warm.cols, 'global listeners do not accumulate across 60 page changes');
    check(later.artTargets <= warm.artTargets && later.detached === 0, 'art observers release discarded pages');

    await js('Host.call("play", { ids: ["a", "b"], start: 0, shuffle: false })');
    await until(() => audio('ctx.state === "running" && !A().el.paused'), 'play');
    await delay(500);
    check(await audio('meter.l > 0 && meter.r > 0'), 'audio still reaches DSP');
    await js('Host.call("toggle")');
    await until(() => audio('A().el.paused'), 'pause');
    await quiet('paused');
    await js('Host.call("seek", { pos: 2 })');
    await until(() => audio('Math.abs(A().el.currentTime - 2) < 0.1'), 'paused seek');
    check(await audio('A().el.paused'), 'seeking while paused does not start playback');
    await js('NowPlaying.show()'); await delay(100);
    check(await js('document.querySelector("#np-pos").textContent === "0:02"'), 'paused Now Playing displays the current position');
    await js('NowPlaying.hide()');
    await js('Host.call("toggle")');
    await until(() => audio('ctx.state === "running" && !A().el.paused'), 'resume');
    ui.hide();
    if (observeOnly) await delay(1000);
    else await until(() => js('document.hidden || App.uiVisible === false'), 'hidden UI notification');
    await delay(200);
    report.hidden = await js('({ hidden: document.hidden, visible: App.uiVisible !== false, raf: App.frameRaf || 0 })');
    check((report.hidden.hidden || !report.hidden.visible) && report.hidden.raf === 0, 'hiding the window stops UI frames');
    const pos = await audio('A().el.currentTime'); await delay(600);
    check(await audio('A().el.currentTime') > pos + 0.3, 'hidden playback keeps advancing');
    ui.showInactive(); await delay(300);
    await until(() => audio('nextReady'), 'gapless preload');
    await js('Host.call("seek", { pos: 11.65 })');
    await until(() => audio('A().id === "b" && !A().el.paused'), 'gapless handoff');
    check(await audio('ctx.state === "running"'), 'gapless handoff keeps the audio context running');
    await js('Host.call("seek", { pos: 11.75 })');
    await until(() => audio('!A().src'), 'end of queue');
    await quiet('ended');

    // Exercise the real YouTube panel's browser preferences/preload with local media and no online account.
    await js('Host.call("yt.show", { x: 0, y: 0, w: 100, h: 100 })');
    const panel = webContents.getAllWebContents().find(w => w !== ui.webContents && w !== engine.webContents);
    assert.ok(panel, 'YouTube panel exists');
    const panelFile = path.join(root, 'panel.html');
    fs.writeFileSync(panelFile, '<video src="a.wav"></video><ytmusic-player-bar><div class="title">Panel test</div><div class="byline">MIKU test</div></ytmusic-player-bar>');
    await panel.loadFile(panelFile);
    await panel.executeJavaScript('document.querySelector("video").play()', true);
    await until(() => panel.executeJavaScript('document.querySelector("video").currentTime > 0.1'), 'panel playback');
    await js('Host.call("yt.hide")'); ui.hide(); await delay(200);
    const panelPos = await panel.executeJavaScript('document.querySelector("video").currentTime');
    await delay(1200);
    check(await panel.executeJavaScript('document.querySelector("video").currentTime') > panelPos + 0.8, 'hidden YouTube panel keeps playing audio');
    check(await js('document.hidden || App.uiVisible === false'), 'YouTube panel does not keep hidden UI rendering');
    await panel.executeJavaScript('document.querySelector("video").pause();');
    ui.showInactive(); await delay(200);

    await js('Host.call("play", { ids: ["a"], start: 0, shuffle: false })');
    for (let i = 0; i < 20; i++) { engine.webContents.send('eng', { c: 'pause' }); engine.webContents.send('eng', { c: 'resume' }); }
    engine.webContents.send('eng', { c: 'pause' });
    await until(() => audio('A().el.paused'), 'rapid pause/resume');
    await quiet('rapidToggle');
    assert.equal(BrowserWindow.getAllWindows().length, 2, 'only one UI and one audio engine window');
    if (process.env.MIKU_TEST_REPORT) fs.writeFileSync(process.env.MIKU_TEST_REPORT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    clearTimeout(watchdog); app.exit(0);
  } catch (e) { console.error(JSON.stringify(report, null, 2)); console.error(e.stack); clearTimeout(watchdog); app.exit(1); }
});

'use strict';
// Run with an unpacked Electron binary. Uses a temporary profile and fixture library only.
const { app, BrowserWindow, session } = require('electron');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const root = process.env.MIKU_TEST_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'miku-navigation-regression-'));
const testApp = path.join(root, 'app');
fs.mkdirSync(root, { recursive: true });
fs.cpSync(path.resolve(__dirname, '../app'), testApp, { recursive: true });
const gestureFile = path.join(testApp, 'wwwroot/mac-navigation.js');
fs.writeFileSync(gestureFile, fs.readFileSync(gestureFile, 'utf8').replace('const now = e.timeStamp;', 'const now = e.timeStamp; window.navLastInput = performance.now();'));
for (const key of ['userData', 'sessionData', 'cache', 'logs']) {
  const dir = path.join(root, key); fs.mkdirSync(dir, { recursive: true }); app.setPath(key, dir);
}
fs.writeFileSync(path.join(root, 'userData/settings.json'), JSON.stringify({
  folders: [], onlineArt: false, onlineLyrics: false, artistImages: false, remoteEnabled: false,
  ui: { lang: 'zh-Hant', theme: 'glass' },
}));
const tracks = Array.from({ length: 24 }, (_, i) => ({
  id: 'fixture-' + i, path: path.join(root, 'fixture-' + i + '.wav'), title: 'Fixture ' + i,
  artist: 'Artist ' + i, albumArtist: 'Artist ' + i, album: 'Album ' + i,
  codec: 'WAV', sampleRate: 48000, bits: 16, channels: 2, duration: 12, trackNo: 1, discNo: 1, mtime: 1,
}));
fs.writeFileSync(path.join(root, 'userData/library.json'), JSON.stringify({ version: 1, tracks, folderArt: {} }));
app.commandLine.appendSwitch('mute-audio');
app.on('browser-window-created', (_e, win) => { win.show = () => win.showInactive(); });
require(path.join(testApp, 'main/main.js'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (await fn()) return; await delay(40); }
  throw new Error('Timed out: ' + label);
}
const report = { checks: [] };
function check(ok, label) { report.checks.push({ label, passed: !!ok }); assert.ok(ok, label); }
const watchdog = setTimeout(() => { console.error('Navigation regression timed out'); app.exit(1); }, 60000);
app.whenReady().then(async () => {
  try {
    app.setActivationPolicy('accessory');
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_d, cb) => cb({ cancel: true }));
    let ui, engine;
    await until(() => {
      const wins = BrowserWindow.getAllWindows();
      ui = wins.find(w => w.webContents.getURL().startsWith('miku://app/'));
      engine = wins.find(w => w.webContents.getURL().startsWith('miku://engine/'));
      return ui && engine && !ui.webContents.isLoading();
    }, 'app loaded');
    const js = code => ui.webContents.executeJavaScript(code, true);
    await until(() => js('typeof Lib !== "undefined" && Lib.albums.length === 24'), 'fixture library');
    await js('App.settings.folders = ["navigation-test"]; window.navTest = { pops: 0 }; window.addEventListener("popstate", () => navTest.pops++); Router.render(false, "fade");');
    const hash = () => js('location.hash');
    const wheel = async (events, selector = '#view', options = {}) => {
      await delay(350);
      return js(`(() => {
        const target = document.querySelector(${JSON.stringify(selector)}), prevented = [];
        for (const [deltaX, deltaY] of ${JSON.stringify(events)}) {
          const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX, deltaY, ...${JSON.stringify(options)} });
          target.dispatchEvent(e); prevented.push(e.defaultPrevented);
        }
        return prevented;
      })()`);
    };
    await wheel([[-80, 0], [-80, 0]]); await delay(100);
    check(await hash() === '#/home' && !ui.webContents.navigationHistory.canGoBack(), 'back at first page is harmless');
    const album = await js('Lib.albums[0].id');
    await js(`go('#/albums'); go('#/artists'); go(${JSON.stringify('#/album/' + album)});`);
    await delay(400);

    // Trusted Chromium wheel input checks the real renderer path and natural-scroll sign.
    const point = await js('(() => { const r = document.querySelector(".hero.album h1").getBoundingClientRect(); return { x: Math.round(r.left + 8), y: Math.round(r.top + 8) }; })()');
    const before = await js('navTest.pops');
    for (let i = 0; i < 35; i++) {
      ui.webContents.sendInputEvent({ type: 'mouseWheel', ...point, deltaX: 35, deltaY: 0, hasPreciseScrollingDeltas: true });
      await delay(18);
    }
    await until(async () => await hash() === '#/artists', 'trusted swipe back');
    await until(() => js('performance.now() - navLastInput > 400'), 'trusted wheel input drained');
    check(await js('navTest.pops') === before + 1, 'rightward page swipe returns exactly one page including its momentum');
    await wheel([[60, 0], [60, 0], [60, 0]]);
    await until(async () => await hash() === '#/album/' + album, 'forward');
    check(true, 'opposite swipe moves forward');

    await delay(350);
    const queuedBefore = await js('navTest.pops');
    await js(`window.navQueuedAt = performance.now(); window.queuedWheel = offset => {
      const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: -160 });
      Object.defineProperty(e, 'timeStamp', { value: navQueuedAt + offset });
      document.querySelector('#view').dispatchEvent(e);
    }; queuedWheel(0);`);
    await until(async () => await hash() === '#/artists', 'queued swipe first navigation');
    await delay(420); // Dispatch a delayed event from that same input gesture after the page has changed.
    await js('queuedWheel(30)'); await delay(80);
    check(await hash() === '#/artists' && await js('navTest.pops') === queuedBefore + 1, 'delayed input from one swipe cannot navigate another page');
    await wheel([[160, 0]]);
    await until(async () => await hash() === '#/album/' + album, 'forward after delayed input');

    for (const [label, events, options] of [
      ['short swipe', [[-50, 0], [-50, 0]], {}],
      ['reversed swipe', [[-80, 0], [80, 0]], {}],
      ['diagonal scroll', [[-80, 60], [-80, 60]], {}],
      ['vertical scroll with later sideways drift', [[0, 40], [-200, 1]], {}],
      ['ordinary mouse wheel', [[-100, 0], [-100, 0]], { deltaMode: 1 }],
      ['pinch gesture', [[-100, 0], [-100, 0]], { ctrlKey: true }],
      ['Command wheel', [[-100, 0], [-100, 0]], { metaKey: true }],
      ['Shift wheel', [[-100, 0], [-100, 0]], { shiftKey: true }],
    ]) {
      const prevented = await wheel(events, '#view', options); await delay(80);
      check(await hash() === '#/album/' + album && prevented.every(v => !v), label + ' preserves the page and default control behavior');
    }
    await js(`document.querySelector('#view').insertAdjacentHTML('beforeend', '<input id="nav-input"><div id="nav-edit" contenteditable="true">edit</div><div class="slider" id="nav-slider"></div><div class="eq-graph" id="nav-eq"></div>');`);
    for (const selector of ['#nav-input', '#nav-edit', '#nav-slider', '#nav-eq']) {
      const prevented = await wheel([[-100, 0], [-100, 0]], selector); await delay(50);
      check(await hash() === '#/album/' + album && prevented.every(v => !v), selector + ' retains its wheel control');
    }

    await js("go('#/home')"); await delay(400);
    const railPoint = await js('(() => { const el = document.querySelector(".rail"); el.scrollLeft = 0; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + 60), y: Math.round(r.top + 40) }; })()');
    for (let i = 0; i < 8; i++) {
      ui.webContents.sendInputEvent({ type: 'mouseWheel', ...railPoint, deltaX: -50, deltaY: 0, hasPreciseScrollingDeltas: true });
      await delay(25);
    }
    await until(() => js('performance.now() - navLastInput > 400'), 'rail wheel input drained');
    await delay(350);
    check(await hash() === '#/home' && await js('document.querySelector(".rail").scrollLeft > 0'), 'album rail actually scrolls horizontally without navigating');
    await js('document.querySelector(".rail").scrollLeft = 0');
    const railPrevented = await wheel([[-200, 0], [-200, 0]], '.rail .card'); await delay(100);
    check(await hash() === '#/home' && railPrevented.every(v => !v), 'rail edges do not turn into page navigation');
    const scrollPoint = await js('(() => { const r = document.querySelector(".rail-head").getBoundingClientRect(); document.querySelector("#content").scrollTop = 0; return { x: Math.round(r.left + 80), y: Math.round(r.top + 10) }; })()');
    for (let i = 0; i < 5; i++) { ui.webContents.sendInputEvent({ type: 'mouseWheel', ...scrollPoint, deltaY: -50, deltaX: 0, hasPreciseScrollingDeltas: true }); await delay(25); }
    await until(() => js('performance.now() - navLastInput > 400'), 'vertical wheel input drained');
    check(await hash() === '#/home' && await js('document.querySelector("#content").scrollTop > 0'), 'ordinary vertical scrolling still scrolls the page');

    await delay(750);
    ui.emit('swipe', {}, 'left'); ui.emit('swipe', {}, 'left');
    await until(async () => await hash() === '#/album/' + album, 'native swipe');
    check(true, 'native three-finger back uses the same history and suppresses duplicate delivery');
    await delay(750); ui.emit('swipe', {}, 'right');
    await until(async () => await hash() === '#/home', 'native forward');
    check(true, 'native three-finger forward is connected');
    ui.emit('swipe', {}, 'up'); await delay(80);
    check(await hash() === '#/home', 'vertical native gestures do not navigate');
    await js("Drawer.toggle('queue')");
    await wheel([[-80, 0], [-80, 0]], '#queue-body');
    await until(() => js('Drawer.open === null'), 'overlay back');
    check(await hash() === '#/home' && await js('OverlayHistory.stack.length === 0'), 'back first closes the overlay and preserves the page');
    await delay(300);
    check(await js('App.frameRaf === 0') && await engine.webContents.executeJavaScript('ctx?.state === "suspended"'), 'gesture handling adds no idle animation or audio loop');
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ root, ...report }, null, 2)); clearTimeout(watchdog); app.exit(0);
  } catch (e) {
    console.error(e.stack || e); console.error(JSON.stringify(report, null, 2)); clearTimeout(watchdog); app.exit(1);
  }
});

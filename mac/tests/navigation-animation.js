'use strict';
// Real renderer regression for the return animation; all data stays in a temporary profile.
const { app, BrowserWindow, session } = require('electron');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const root = process.env.MIKU_TEST_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'miku-animation-test-'));
const source = process.env.MIKU_TEST_APP || path.resolve(__dirname, '../app');
const testApp = path.join(root, 'app');
fs.cpSync(source, testApp, { recursive: true });
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
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (await fn()) return; await delay(15); }
  throw new Error('Timed out: ' + label);
}
const report = { checks: [] };
function check(ok, label) { report.checks.push({ label, passed: !!ok }); assert.ok(ok, label); }
function save() { fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2)); }
const watchdog = setTimeout(() => { console.error('Animation regression timed out'); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  try {
    app.setActivationPolicy('accessory');
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_d, cb) => cb({ cancel: true }));
    let ui;
    await until(() => {
      ui = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('miku://app/'));
      return ui && !ui.webContents.isLoading();
    }, 'app loaded');
    const js = code => ui.webContents.executeJavaScript(code, true);
    await until(() => js('typeof Lib !== "undefined" && Lib.albums.length === 24'), 'fixture library');
    await js(`artUrl = () => 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#1ec8a2"/><circle cx="128" cy="128" r="80" fill="#112642"/><text x="128" y="150" text-anchor="middle" font-size="60" fill="white">M</text></svg>');
      App.settings.folders = ['animation-test']; go('#/albums');
      window.animationTest = { pops: 0 }; window.addEventListener('popstate', () => animationTest.pops++);
      window.testWheel = (dx, dy = 0, inputTime) => { const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: dx, deltaY: dy }); if (inputTime !== undefined) Object.defineProperty(e, 'timeStamp', { value: inputTime }); document.querySelector('#view').dispatchEvent(e); return e.defaultPrevented; }; void 0;`);
    await until(() => js('!!document.querySelector("[data-album] img.ok")'), 'fixture artwork loaded');
    await js('document.querySelector("#content").scrollTop = 300'); await delay(100);
    const album = await js(`(() => {
      const top = document.querySelector('#content').getBoundingClientRect().top;
      const el = [...document.querySelectorAll('[data-album]')].find(el => el.querySelector('img.ok') && el.getBoundingClientRect().top > top + 30);
      window.returnTarget = el.dataset.album; window.returnScroll = document.querySelector('#content').scrollTop;
      el.closest('.card').click(); return returnTarget;
    })()`);
    await until(() => js('!!document.querySelector(".hero.album .cover img.ok")'), 'album artwork');
    await delay(750);
    const before = await js('animationTest.pops');
    const inputTime = await js('performance.now()');
    await js(`testWheel(-160, 0, ${inputTime})`);
    await until(() => js('!!document.querySelector(".flip-clip .flip-fly")'), 'return cover flight starts');
    check(await js('location.hash === "#/albums" && Math.abs(document.querySelector("#content").scrollTop - returnScroll) < 2'), 'back restores the list and its scroll position');
    check(await js('!document.querySelector("#view").classList.contains("enter-back")'), 'return cover does not inherit a competing page fade');
    let survived = true, running = false;
    report.frames = [];
    for (let i = 0; i < 7; i++) {
      // Preserve the original input times even when the renderer takes time to rebuild the grid.
      await js(`testWheel(-20, 1, ${inputTime + (i + 1) * 30})`); await delay(30);
      const frame = await js(`(() => { const el = document.querySelector('.flip-fly'); return { alive: !!el,
        running: !!el && el.getAnimations().some(a => a.playState === 'running'),
        targetHidden: document.querySelector('[data-album="${album}"]')?.style.visibility === 'hidden',
        animations: el?.getAnimations().map(a => ({ playState: a.playState, currentTime: a.currentTime })),
        transform: el && getComputedStyle(el).transform, at: performance.now() }; })()`);
      report.frames.push(frame);
      survived = survived && frame.alive && frame.targetHidden; running = running || frame.running;
    }
    check(survived && running, 'the return animation survives the swipe tail and keeps moving');
    check(await js('animationTest.pops') === before + 1, 'swipe tail still returns only one page');
    await until(() => js('!document.querySelector(".flip-clip")'), 'return animation cleanup');
    check(await js(`getComputedStyle(document.querySelector('[data-album="${album}"]')).visibility === 'visible' && !document.querySelector('.flip-dest')`), 'destination cover is restored without a leftover clone');

    // An intentional vertical scroll should still interrupt the flight immediately.
    await js(`document.querySelector('[data-album="${album}"]').closest('.card').click()`);
    await until(() => js('!!document.querySelector(".hero.album .cover img.ok")'), 'second album visit');
    await delay(750); await js('testWheel(-160)');
    await until(() => js('!!document.querySelector(".flip-clip .flip-fly")'), 'second return flight');
    const verticalPrevented = await js('testWheel(0, 40)');
    await until(() => js('!document.querySelector(".flip-clip")'), 'vertical input ends flight');
    check(!verticalPrevented, 'new vertical scrolling interrupts the flight and remains usable');

    // Chromium's native wheel path, including momentum after the animation starts.
    await js(`document.querySelector('[data-album="${album}"]').closest('.card').click()`);
    await until(() => js('!!document.querySelector(".hero.album .cover img.ok")'), 'native-input album visit');
    await delay(750);
    const point = await js('(() => { const r = document.querySelector(".hero.album h1").getBoundingClientRect(); return { x: Math.round(r.left + 8), y: Math.round(r.top + 8) }; })()');
    const nativeBefore = await js('animationTest.pops');
    report.nativeFrames = [];
    for (let i = 0; i < 38; i++) {
      ui.webContents.sendInputEvent({ type: 'mouseWheel', ...point, deltaX: 35, deltaY: 0, hasPreciseScrollingDeltas: true });
      await delay(18);
      const frame = await js(`(() => { const el = document.querySelector('.flip-fly'); return { alive: !!el,
        time: el?.getAnimations().find(a => a.playState === 'running')?.currentTime,
        hash: location.hash }; })()`);
      report.nativeFrames.push(frame);
    }
    check(report.nativeFrames.some(f => f.alive && f.time > 350) && await js('animationTest.pops') === nativeBefore + 1,
      'native Chromium wheel momentum keeps the cover moving through its return');
    await until(() => js('!document.querySelector(".flip-clip")'), 'native flight cleanup');
    await delay(400);

    await js("go('#/settings'); go('#/tracks')"); await delay(350);
    await js('testWheel(-160)');
    await until(() => js('location.hash === "#/settings"'), 'ordinary page back');
    check(await js('document.querySelector("#view").classList.contains("enter-back")'), 'ordinary page back keeps its existing return transition');
    await delay(400);
    check(await js('App.frameRaf === 0'), 'return effects finish without adding an idle visual loop');
    save(); console.log(JSON.stringify({ root, ...report }, null, 2)); clearTimeout(watchdog); app.exit(0);
  } catch (e) { save(); console.error(e.stack || e); console.error(JSON.stringify(report, null, 2)); clearTimeout(watchdog); app.exit(1); }
});

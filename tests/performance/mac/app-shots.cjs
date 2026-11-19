'use strict';
// Screenshots of the real Mac MIKU in the same states, with every animation held at the same moment, to check that a
// change left the page looking the same:
//
//   node tests/performance/mac/app-shots.cjs --app <before MIKU.app> --out before/
//   node tests/performance/mac/app-shots.cjs --app <after MIKU.app> --out after/
//   node tests/performance/mac/app-shots.cjs --diff before/ after/       (pixels that differ, per state)
//
// Same throw-away profile as app-soak.cjs (muted, offline); themes are switched in the page.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const S = require('./app-soak.cjs');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };

const THEMES = (arg('themes', 'glass,miku,vinyl')).split(',');
const STATES = {
  home: `go('#/home')`, albums: `go('#/albums')`, album: `go('#/album/' + Lib.albums[3].id)`, artists: `go('#/artists')`,
  settings: `go('#/settings/audio')`, look: `go('#/settings/look')`, nowplaying: `NowPlaying.show()`,
};

async function shoot() {
  const out = path.resolve(arg('out', 'shots')); fs.mkdirSync(out, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'miku-shots-')); S.makeProfile(profile);
  const child = spawn(path.join(S.APP, 'Contents/MacOS/Electron'), ['--user-data-dir=' + profile, '--remote-debugging-port=' + S.PORT,
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], { stdio: 'ignore' });
  try {
    const cdp = await S.connect();
    await S.waitFor(cdp, `typeof Lib !== 'undefined' && Lib.loaded && Router.cur && Router.cur.name`, 60000);
    await S.ev(cdp, `(async () => { const ids = Lib.tracks.slice(0, 400).map(t => t.id); await Host.call('play', { ids, start: 0, shuffle: false }); })()`);
    await S.sleep(6000);
    for (const theme of THEMES) {
      await S.ev(cdp, `(() => { if (typeof Theme !== 'undefined' && Theme.set) Theme.set('${theme}'); else { document.documentElement.dataset.theme = '${theme}'; } return 1; })()`);
      for (const [name, step] of Object.entries(STATES)) {
        await S.ev(cdp, `NowPlaying.open && NowPlaying.hide(); 1`); await S.sleep(500);
        await S.ev(cdp, step); await S.sleep(2500);
        // every animation at the same moment, the progress bar and times at the same place
        await S.ev(cdp, `(() => { clearInterval(IdleFx.stepTimer); IdleFx.stepTimer = 1; cancelAnimationFrame(App.frameRaf); clearTimeout(App.frameTimer);
          for (const a of document.getAnimations()) { try { a.pause(); a.currentTime = a.effect.getTiming().iterations === Infinity ? 10000 : a.effect.getComputedTiming().endTime; } catch (e) { } }
          document.querySelectorAll('#b-pos, #np-pos').forEach(e => e.textContent = '1:00'); document.querySelectorAll('#b-dur, #np-dur').forEach(e => e.textContent = '4:00');
          return 1; })()`);
        await S.sleep(400);
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(out, `${theme}-${name}.png`), Buffer.from(data, 'base64'));
        await S.ev(cdp, `IdleFx.stepTimer = 0; IdleFx.steps.clear(); for (const a of document.getAnimations()) { try { a.play(); } catch (e) { } } IdleFx.sync(); App.frame(); 1`);
        console.log('shot', theme, name);
      }
    }
    await S.ev(cdp, `Host.call('quit')`).catch(() => { });
    await S.sleep(2000);
  } finally {
    try { process.kill(child.pid); } catch (e) { }
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

/* ── comparing: a minimal PNG reader (8-bit RGB / RGBA, as Chromium writes them) ── */
function readPng(file) {
  const b = fs.readFileSync(file);
  let i = 8, w = 0, h = 0, ch = 4; const idat = [];
  while (i < b.length) {
    const len = b.readUInt32BE(i), type = b.toString('ascii', i + 4, i + 8), d = b.subarray(i + 8, i + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ch = d[9] === 6 ? 4 : 3; }
    else if (type === 'IDAT') idat.push(d);
    i += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch, px = Buffer.alloc(w * h * ch);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[y * stride + x - ch] : 0, up = y ? px[(y - 1) * stride + x] : 0, ul = y && x >= ch ? px[(y - 1) * stride + x - ch] : 0;
      let v = row[x];
      if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const p = a + up - ul, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - ul); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : ul; }
      px[y * stride + x] = v & 255;
    }
  }
  return { w, h, ch, px };
}
function diff(a, b) {
  let worst = 0;
  for (const f of fs.readdirSync(a).filter(f => f.endsWith('.png')).sort()) {
    if (!fs.existsSync(path.join(b, f))) { console.log(f.padEnd(28), 'missing in', b); continue; }
    const A = readPng(path.join(a, f)), B = readPng(path.join(b, f));
    if (A.w !== B.w || A.h !== B.h) { console.log(f.padEnd(28), `size ${A.w}×${A.h} vs ${B.w}×${B.h}`); worst = 1; continue; }
    let n = 0, max = 0;
    for (let p = 0; p < A.w * A.h; p++) {
      let d = 0; for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(A.px[p * A.ch + c] - B.px[p * B.ch + c]));
      if (d > 2) n++; max = Math.max(max, d);
    }
    const pct = n / (A.w * A.h) * 100; worst = Math.max(worst, pct);
    console.log(f.padEnd(28), `${n} pixels differ (${pct.toFixed(3)} %), largest difference ${max}`);
  }
  return worst;
}

if (args[0] === '--diff') process.exitCode = diff(path.resolve(args[1]), path.resolve(args[2])) > 0.05 ? 1 : 0;
else shoot().catch(e => { console.error(e.stack || e); process.exit(1); });

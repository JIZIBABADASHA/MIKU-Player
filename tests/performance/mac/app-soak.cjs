'use strict';
// The real Mac MIKU (Electron, its main process, the page, the GPU process and the playback core's helpers) played and
// used for as long as asked, measured from outside: CPU and resident memory of every process it runs, and what the page
// still holds after a full collection (JS heap, DOM nodes, listeners). Fails when something keeps growing, or when the
// app at rest costs more than the ceilings below.
//
//   node tests/performance/mac/app-soak.cjs --minutes 60
//   node tests/performance/mac/app-soak.cjs --rounds 20 --app /Applications/MIKU.app --json out.json
//   node tests/performance/mac/app-soak.cjs --compare before.json after.json      (prints both side by side)
//
// It never touches the listener's own MIKU: it copies settings.json, library.json, Art, Lyrics and ext from
// ~/Library/Application Support/MIKU into a throw-away profile, plays muted on the system's shared output (no exclusive
// mode, no online lookups, no phone remote, no updates), and quits that copy at the end. Needs Node 22+ (WebSocket).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../../..');
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (args[0] === '--compare') { compare(args[1], args[2]); process.exit(0); }

const APP = path.resolve(arg('app', path.join(ROOT, 'mac/build/work/root-' + (os.arch() === 'arm64' ? 'arm64' : 'x64') + '/MIKU.app')));
const MINUTES = +arg('minutes', 0), ROUNDS = +arg('rounds', MINUTES ? 1e9 : 20), EVERY = +arg('every', 4);
const PORT = +arg('port', 9339), JSON_OUT = arg('json', null), SOURCE = arg('profile', path.join(os.homedir(), 'Library/Application Support/MIKU'));

// at rest, playing, window shown (per cent of one core; resident MB). Wide on purpose: they catch an app that got
// several times dearer. The growth limits are the strict part.
const CEIL = {
  // (process CPU swings by ±10 points between runs on a Mac doing other things: the style-pass ceilings below are the
  // sharp test for per-frame work, these catch what they cannot see, e.g. Glass's orbs at 120 Hz cost the GPU ~60 %)
  restCpu: { main: 6, renderer: 30, gpu: 50, helpers: 40 },
  pausedCpu: { main: 2, renderer: 3, gpu: 3 },
  // the page's own style passes a second at rest: the progress bar (~10) and the badge's and Glass orbs' shared 24 fps
  // clock. Per-frame work (120 a second on this Mac's screen) shows up far above these.
  restStyles: { home: 60, nowPlaying: 80, homeAfter: 60 },
  nodesPerRound: 25, listenersPerRound: 3, heapMBPerRound: 0.6, rendererMBPerRound: 4, mainMBPerRound: 1.5,
};

async function main() {
  if (!fs.existsSync(APP)) throw new Error('No MIKU.app at ' + APP + ' (build it, or pass --app)');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'miku-soak-'));
  makeProfile(profile);
  const bin = path.join(APP, 'Contents/MacOS/Electron');
  const child = spawn(bin, ['--user-data-dir=' + profile, '--remote-debugging-port=' + PORT, '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--js-flags=--expose-gc', '--enable-precise-memory-info'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
  const out = { app: APP, version: readVersion(), started: new Date().toISOString(), rounds: [], rest: {}, problems: [] };
  let cdp;
  try {
    cdp = await connect();
    await cdp.send('Performance.enable');
    await cdp.send('Runtime.enable');
    const errors = [];
    cdp.on('Runtime.exceptionThrown', e => errors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)));
    await waitFor(cdp, `typeof Lib !== 'undefined' && Lib.loaded && Router.cur && Router.cur.name`, 60000);
    const tracks = await ev(cdp, `Lib.tracks.length`);
    if (!tracks) throw new Error('the copied library has no tracks');
    await ev(cdp, `(async () => { const ids = Lib.tracks.slice(0, 400).map(t => t.id); await Host.call('play', { ids, start: 0, shuffle: false }); })()`);
    await sleep(8000);
    if (!(await ev(cdp, `(async () => (await Host.call('state')).playing)()`))) out.problems.push('playback did not start (the numbers below are for a paused app)');

    // at rest: what each process costs per second, playing on home, playing on now playing, paused
    await ev(cdp, `go('#/home')`); await sleep(6000);
    out.rest.home = await rest(child.pid, 20000, cdp);
    await ev(cdp, `NowPlaying.show()`); await sleep(6000);
    out.rest.nowPlaying = await rest(child.pid, 20000, cdp);
    await ev(cdp, `NowPlaying.hide()`); await sleep(1500);

    // rounds of use
    const t0 = Date.now();
    out.rounds.push(await sample(cdp, child.pid, 0));
    for (let r = 1; r <= ROUNDS && (!MINUTES || Date.now() - t0 < MINUTES * 60000); r++) {
      await round(cdp, r);
      if (r % EVERY === 0) { const s = await sample(cdp, child.pid, r); out.rounds.push(s); log(s); }
    }
    await ev(cdp, `go('#/home')`); await sleep(6000);
    out.rest.homeAfter = await rest(child.pid, 20000, cdp);
    await ev(cdp, `(async () => { const s = await Host.call('state'); if (s.playing) await Host.call('toggle'); })()`); await sleep(5000);
    out.rest.paused = await rest(child.pid, 15000, cdp);
    out.pageErrors = errors.slice(0, 10);
    out.minutes = +((Date.now() - t0) / 60000).toFixed(1);
    judge(out);
  } finally {
    try { if (cdp) await ev(cdp, `Host.call('quit')`).catch(() => { }); } catch (e) { }
    await sleep(2500);
    try { process.kill(child.pid); } catch (e) { }
    for (const pid of tree(child.pid)) { try { process.kill(pid, 'SIGKILL'); } catch (e) { } }
    fs.rmSync(profile, { recursive: true, force: true });
  }
  print(out);
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
  if (out.problems.length) { console.log('\nFAIL\n- ' + out.problems.join('\n- ')); process.exitCode = 1; }
  else console.log('\nPASS');
}

/* ── the throw-away profile ── */
function makeProfile(dir) {
  for (const f of ['library.json', 'settings.json']) if (fs.existsSync(path.join(SOURCE, f))) fs.copyFileSync(path.join(SOURCE, f), path.join(dir, f));
  // covers, lyrics and the modules' own data (MoodWave's analysis: without it, its helper analyses the whole library
  // again, several cores for the whole run). Copied as APFS clones: instant, and no extra disk space.
  for (const d of ['Art', 'Lyrics', 'ext']) if (fs.existsSync(path.join(SOURCE, d))) execFileSync('cp', ['-Rc', path.join(SOURCE, d), path.join(dir, d)]);
  const file = path.join(dir, 'settings.json');
  const s = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  Object.assign(s, { autoUpdate: false, remoteEnabled: false, onlineArt: false, onlineLyrics: false, artistImages: false, watchFolders: false,
    outputMode: 'coreaudio', deviceId: null, muted: true, maximized: false, window: [40, 40, 1440, 900], remoteLib: undefined });
  fs.writeFileSync(file, JSON.stringify(s));
}
function readVersion() { try { return JSON.parse(fs.readFileSync(path.join(APP, 'Contents/Resources/app/package.json'), 'utf8')).version; } catch (e) { return '?'; } }

/* ── one round: what a listener does in a sitting ── */
async function round(cdp, r) {
  const steps = [
    `go('#/home')`, `(() => { const b = document.querySelectorAll('.rail-nav .rail-btn')[1]; if (b && !b.disabled) b.click(); })()`,
    `go('#/albums')`, `(() => { const el = document.querySelector('#main, #view'); if (el) el.scrollTop += 2400; })()`,
    `(() => { const a = Lib.albums[(${r} * 7) % Lib.albums.length]; if (a) go('#/album/' + encodeURIComponent(a.id)); })()`,
    `go('#/artists')`, `(() => { const a = (Lib.artists || [])[(${r} * 3) % Math.max(1, (Lib.artists || []).length)]; if (a) go('#/artist/' + encodeURIComponent(a.name || a.id || a)); })()`,
    `go('#/tracks')`, `go('#/search/' + encodeURIComponent(['a', 'の', 'love', '初音'][${r} % 4]))`,
    `go('#/settings/audio')`, `go('#/settings/library')`, `go('#/settings/look')`, `go('#/settings/keys')`, `go('#/settings/other')`,
    `go('#/queue')`, `go('#/home')`, `NowPlaying.show()`, `Host.call('next')`, `NowPlaying.hide()`,
  ];
  for (const s of steps) { await ev(cdp, s).catch(() => { }); await sleep(700); }
}

/* ── measuring ── */
async function sample(cdp, pid, r) {
  for (let i = 0; i < 3; i++) { await cdp.send('HeapProfiler.collectGarbage'); await sleep(100); }
  const m = await metrics(cdp), p = procs(pid);
  return { round: r, at: Date.now(), heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(2), nodes: m.Nodes, listeners: m.JSEventListeners, documents: m.Documents,
    rss: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, +(v.rss / 1024).toFixed(1)])) };
}
/** CPU (% of one core) and resident MB of each kind of process over `ms`, and the page's own counters per second. */
async function rest(pid, ms, cdp) {
  const a = procs(pid), m0 = await metrics(cdp); await sleep(ms); const b = procs(pid), m1 = await metrics(cdp);
  const cpu = {}, rss = {}, sec = m1.Timestamp - m0.Timestamp;
  for (const k of Object.keys(b)) { cpu[k] = +(((b[k].cpu - (a[k]?.cpu || 0)) / (ms / 1000)) * 100).toFixed(1); rss[k] = +(b[k].rss / 1024).toFixed(1); }
  const page = { stylesPerSec: +((m1.RecalcStyleCount - m0.RecalcStyleCount) / sec).toFixed(1), layoutsPerSec: +((m1.LayoutCount - m0.LayoutCount) / sec).toFixed(1),
    mainThreadPct: +((m1.TaskDuration - m0.TaskDuration) / sec * 100).toFixed(1) };
  const seen = await ev(cdp, `(async () => ({ visible: document.visibilityState, uiVisible: App.uiVisible, playing: (await Host.call('state')).playing }))()`).catch(() => null);
  return { cpu, rss, page, seen };
}
/** Every process of this MIKU by kind (main, renderer, gpu, network, helpers): CPU seconds so far, resident KB. */
function procs(root) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,time=,command='], { encoding: 'utf8' }).split('\n').filter(Boolean).map(l => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    return m && { pid: +m[1], ppid: +m[2], rss: +m[3], cpu: secs(m[4]), cmd: m[5] };
  }).filter(Boolean);
  const mine = new Set([root]);
  for (let grew = true; grew;) { grew = false; for (const r of rows) if (!mine.has(r.pid) && mine.has(r.ppid)) { mine.add(r.pid); grew = true; } }
  const out = {};
  for (const r of rows) {
    if (!mine.has(r.pid)) continue;
    const k = r.pid === root ? 'main' : /--type=renderer/.test(r.cmd) ? 'renderer' : /--type=gpu/.test(r.cmd) ? 'gpu' : /--type=utility/.test(r.cmd) ? 'utility' : 'helpers';
    const o = out[k] || (out[k] = { cpu: 0, rss: 0 });
    o.cpu += r.cpu; o.rss += r.rss;
  }
  return out;
}
function secs(t) { const p = t.split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; }
function tree(root) { try { return Object.keys(procs(root)).length ? execFileSync('pgrep', ['-P', String(root)], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number) : []; } catch (e) { return []; } }

/* ── judging ── */
function slope(xs, ys) {
  const n = xs.length; if (n < 3) return 0;
  const mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
  let num = 0, den = 0; for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den ? num / den : 0;
}
function judge(out) {
  // growth: a straight line through the samples after the first (the first rounds fill caches: covers, lyrics, views)
  const s = out.rounds.slice(1), x = s.map(r => r.round);
  out.growth = {
    nodesPerRound: +slope(x, s.map(r => r.nodes)).toFixed(2), listenersPerRound: +slope(x, s.map(r => r.listeners)).toFixed(2),
    heapMBPerRound: +slope(x, s.map(r => r.heapMB)).toFixed(3),
    rendererMBPerRound: +slope(x, s.map(r => r.rss.renderer || 0)).toFixed(2), mainMBPerRound: +slope(x, s.map(r => r.rss.main || 0)).toFixed(2),
  };
  if (s.length < 4) out.problems.push('too few samples to judge growth (run more rounds)');
  else for (const k of Object.keys(out.growth)) if (out.growth[k] > CEIL[k]) out.problems.push(`${k}: ${out.growth[k]} (limit ${CEIL[k]})`);
  for (const [where, r] of Object.entries({ home: out.rest.home, nowPlaying: out.rest.nowPlaying, homeAfter: out.rest.homeAfter })) {
    for (const [k, lim] of Object.entries(CEIL.restCpu)) if ((r?.cpu[k] || 0) > lim) out.problems.push(`${where}: ${k} at ${r.cpu[k]} % of a core (limit ${lim})`);
  }
  for (const [where, lim] of Object.entries(CEIL.restStyles)) { const v = out.rest[where]?.page?.stylesPerSec || 0; if (v > lim) out.problems.push(`${where}: ${v} style passes a second (limit ${lim})`); }
  for (const [k, lim] of Object.entries(CEIL.pausedCpu)) if ((out.rest.paused?.cpu[k] || 0) > lim) out.problems.push(`paused: ${k} at ${out.rest.paused.cpu[k]} % (limit ${lim})`);
  // the page does the same work after the rounds as before them (its own counters: process CPU is too noisy for this)
  for (const k of ['stylesPerSec', 'layoutsPerSec']) {
    const before = out.rest.home?.page?.[k] || 0, after = out.rest.homeAfter?.page?.[k] || 0;
    if (after > before * 1.3 + 3) out.problems.push(`the page works more after the rounds: ${k} ${before} → ${after} at rest`);
  }
  if (out.pageErrors?.length) out.problems.push('page errors: ' + out.pageErrors.join(' | '));
}
function log(s) { console.log(`round ${String(s.round).padStart(4)}: heap ${s.heapMB} MB, nodes ${s.nodes}, listeners ${s.listeners}, RSS ${Object.entries(s.rss).map(([k, v]) => k + ' ' + v).join(', ')}`); }
function print(out) {
  console.log(`\nMIKU ${out.version} (${out.app}), ${out.rounds.length ? out.rounds[out.rounds.length - 1].round : 0} rounds in ${out.minutes} min`);
  for (const [k, r] of Object.entries(out.rest)) console.log(`at rest, ${k.padEnd(10)} CPU % ${JSON.stringify(r.cpu)}  RSS MB ${JSON.stringify(r.rss)}  page ${JSON.stringify(r.page)} ${JSON.stringify(r.seen)}`);
  console.log('growth per round: ' + JSON.stringify(out.growth));
}
function compare(a, b) {
  const A = JSON.parse(fs.readFileSync(a, 'utf8')), B = JSON.parse(fs.readFileSync(b, 'utf8'));
  console.log(' '.repeat(28) + a.padStart(20) + '  ' + b.padStart(20));
  for (const k of Object.keys(B.rest)) for (const kind of ['cpu', 'rss']) for (const p of Object.keys(B.rest[k][kind]))
    console.log(`${(k + ' ' + kind + ' ' + p).padEnd(28)}${String(A.rest[k]?.[kind]?.[p] ?? '-').padStart(20)}  ${String(B.rest[k][kind][p]).padStart(20)}`);
  for (const k of Object.keys(B.growth || {})) console.log(`${('growth ' + k).padEnd(28)}${String(A.growth?.[k] ?? '-').padStart(20)}  ${String(B.growth[k]).padStart(20)}`);
}

/* ── Chrome DevTools Protocol over the app's debugging port ── */
async function connect() {
  let target;
  for (let i = 0; i < 120 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(t => t.type === 'page' && /^miku:\/\/app\//.test(t.url)); } catch (e) { }
    if (!target) await sleep(500);
  }
  if (!target) throw new Error('MIKU did not open its page on port ' + PORT);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const wait = new Map(), subs = new Map();
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    if (d.id && wait.has(d.id)) { const w = wait.get(d.id); wait.delete(d.id); d.error ? w.rej(new Error(d.error.message)) : w.res(d.result); }
    else if (d.method && subs.has(d.method)) for (const f of subs.get(d.method)) f(d.params);
  };
  return {
    send: (method, params = {}) => new Promise((res, rej) => { const i = ++id; wait.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); }),
    on: (method, f) => { if (!subs.has(method)) subs.set(method, []); subs.get(method).push(f); },
  };
}
async function ev(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function waitFor(cdp, expr, ms) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { if (await ev(cdp, expr)) return; } catch (e) { } await sleep(300); }
  throw new Error('timed out waiting for: ' + expr);
}
async function metrics(cdp) { const { metrics } = await cdp.send('Performance.getMetrics'); return Object.fromEntries(metrics.map(x => [x.name, x.value])); }

if (require.main === module) main().catch(e => { console.error(e.stack || e); process.exit(1); });
module.exports = { round, makeProfile, connect, ev, waitFor, metrics, procs, rest, sleep, PORT, APP };

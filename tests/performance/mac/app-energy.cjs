'use strict';
// What the real Mac MIKU costs in energy, state by state, as Activity Monitor's Energy tab counts it: `top`'s POWER
// (energy impact) and idle wake-ups a second, for every process MIKU runs (main, page, GPU, the playback core's helper).
// A process that wakes often costs energy even at 1 % CPU: wake-ups are what keep the Mac's cores out of their idle
// states. Same throw-away profile as app-soak.cjs (muted, offline, your library and settings).
//
//   node tests/performance/mac/app-energy.cjs [--app <MIKU.app>] [--states play,np,paused,long-pause,hidden]
//   node tests/performance/mac/app-energy.cjs --json after.json; ... --compare before.json after.json
//
// The window must be on screen for the playing states to mean anything (macOS stops drawing a covered window).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const S = require('./app-soak.cjs');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };

function kids(root) {
  return execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n').map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .filter(m => +m[1] === root || +m[2] === root)
    .map(m => ({ pid: +m[1], name: +m[1] === root ? 'main' : /type=renderer/.test(m[3]) ? 'page' : /type=gpu/.test(m[3]) ? 'gpu' : /type=utility/.test(m[3]) ? 'network' : path.basename(m[3].split(' ')[0]) }));
}
/** Energy impact and wake-ups a second of each process, over `samples` intervals of `secs` (top in delta mode). */
function energy(root, samples = 3, secs = 5) {
  const ps = kids(root), a = ['-l', String(samples + 1), '-s', String(secs), '-c', 'd', '-stats', 'pid,cpu,power,idlew'];
  for (const p of ps) a.push('-pid', String(p.pid));
  const blocks = execFileSync('top', a, { encoding: 'utf8' }).split(/^PID.*$/m).slice(2);   // the first sample has no delta
  const sum = {};
  for (const b of blocks) for (const l of b.split('\n')) {
    const m = l.trim().match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)/); if (!m) continue;
    const n = ps.find(p => p.pid === +m[1])?.name || m[1], o = sum[n] || (sum[n] = { cpu: 0, power: 0, wakeups: 0 });
    o.cpu += +m[2] / blocks.length; o.power += +m[3] / blocks.length; o.wakeups += +m[4] / secs / blocks.length;
  }
  const out = { total: 0 };
  for (const [k, v] of Object.entries(sum)) { out[k] = { cpu: +v.cpu.toFixed(1), power: +v.power.toFixed(1), wakeups: Math.round(v.wakeups) }; out.total += v.power; }
  out.total = +out.total.toFixed(1);
  return out;
}

const STEPS = {
  idle: [`1`, 0],
  play: [`(async () => { const ids = Lib.tracks.slice(0, 400).map(t => t.id); await Host.call('play', { ids, start: 0, shuffle: false }); go('#/home'); return 1; })()`, 6000],
  np: [`(NowPlaying.show(), 1)`, 4000],
  home: [`(NowPlaying.hide(), go('#/home'), 1)`, 3000],
  paused: [`(async () => { if ((await Host.call('state')).playing) await Host.call('toggle'); return 1; })()`, 4000],
  'long-pause': [`1`, 40000],
  resume: [`(async () => { if (!(await Host.call('state')).playing) await Host.call('toggle'); return 1; })()`, 5000],
  hidden: [`(window.close(), 1)`, 5000],   // the red button: the window hides, music goes on
};
for (const t of ['glass', 'miku', 'vinyl', 'flat', 'washi']) STEPS[t] = [`(Theme.set('${t}'), 1)`, 3000];

async function run() {
  const states = arg('states', 'idle,play,np,home,paused,long-pause,resume,hidden').split(',');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'miku-energy-')); S.makeProfile(profile);
  const child = spawn(path.join(S.APP, 'Contents/MacOS/Electron'), ['--user-data-dir=' + profile, '--remote-debugging-port=' + S.PORT,
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], { stdio: 'ignore' });
  const out = { app: S.APP, states: {} };
  try {
    const cdp = await S.connect();
    await S.waitFor(cdp, `typeof Lib !== 'undefined' && Lib.loaded && Router.cur && Router.cur.name`, 60000);
    await S.sleep(6000);
    for (const st of states) {
      for (const part of st.split('+')) {
        const [expr, settle] = STEPS[part] || [part, 3000];
        // (a hidden window's page may never answer: don't wait on it)
        await Promise.race([S.ev(cdp, expr).catch(e => console.log('  step', part, 'failed:', e.message)), S.sleep(4000)]);
        await S.sleep(settle);
      }
      const e = energy(child.pid); out.states[st] = e;
      console.log(st.padEnd(16), String(e.total).padStart(6), ' ', Object.entries(e).filter(([k]) => k !== 'total').sort((a, b) => b[1].power - a[1].power)
        .map(([k, v]) => `${k} ${v.power} (${v.cpu} % CPU, ${v.wakeups} wake-ups/s)`).join(', '));
    }
    await Promise.race([S.ev(cdp, `Host.call('quit')`).catch(() => { }), S.sleep(3000)]);
    await S.sleep(1500);
  } finally {
    try { process.kill(child.pid); } catch (e) { }
    for (const p of kids(child.pid)) { try { process.kill(p.pid, 'SIGKILL'); } catch (e) { } }
    fs.rmSync(profile, { recursive: true, force: true });
  }
  if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify(out, null, 2));
}

function compare(a, b) {
  const A = JSON.parse(fs.readFileSync(a, 'utf8')), B = JSON.parse(fs.readFileSync(b, 'utf8'));
  console.log('energy impact'.padEnd(16), 'before'.padStart(8), 'after'.padStart(8), '   biggest after');
  for (const [k, v] of Object.entries(B.states)) {
    const top = Object.entries(v).filter(([n]) => n !== 'total').sort((x, y) => y[1].power - x[1].power)[0];
    console.log(k.padEnd(16), String(A.states[k]?.total ?? '-').padStart(8), String(v.total).padStart(8), '  ', top ? `${top[0]} ${top[1].power}` : '');
  }
}

if (args[0] === '--compare') compare(args[1], args[2]);
else if (require.main === module) run().catch(e => { console.error(e.stack || e); process.exit(1); });
module.exports = { energy };

'use strict';
// Runs every scenario once and prints what it measured. `node report.cjs [filter] [--json out.json]`
// A saved JSON is what a later run is compared with: `node report.cjs --compare before.json`.
const fs = require('node:fs');
const { launchBrowser } = require('./lib/harness.cjs');
const { scenarios, runScenario } = require('./scenarios.cjs');

(async () => {
  const args = process.argv.slice(2);
  const flag = name => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, 2)[1]; };
  const out = flag('--json'), compare = flag('--compare');
  const filter = args[0] ? new RegExp(args[0], 'i') : null;
  const before = compare ? JSON.parse(fs.readFileSync(compare, 'utf8')) : null;
  const browser = await launchBrowser();
  const results = { chromium: browser.version(), at: new Date().toISOString(), scenarios: {} };
  for (const sc of scenarios) {
    if (filter && !filter.test(sc.name)) continue;
    process.stdout.write(sc.name + ' … ');
    const t0 = Date.now();
    let r;
    try { r = await runScenario(browser, sc); } catch (e) { r = { failed: String(e && e.stack || e).slice(0, 600) }; }
    if (r === null) { console.log('skipped (module not present)'); continue; }
    results.scenarios[sc.name] = r;
    console.log(((Date.now() - t0) / 1000).toFixed(0) + ' s');
    console.log('   ' + line(sc, r));
    if (before && before.scenarios[sc.name]) console.log('   was: ' + line(sc, before.scenarios[sc.name]));
    if (r.consoleErrors && r.consoleErrors.length) console.log('   console errors: ' + JSON.stringify(r.consoleErrors));
    if (r.errors && r.errors.length) console.log('   page errors: ' + JSON.stringify(r.errors.slice(0, 3)));
    if (r.unknownRpc && r.unknownRpc.length) console.log('   RPCs the stand-in host does not know: ' + r.unknownRpc.join(', '));
  }
  await browser.close();
  if (out) { fs.writeFileSync(out, JSON.stringify(results, null, 1)); console.log('saved ' + out); }
})().catch(e => { console.error(e); process.exit(1); });

function line(sc, r) {
  if (r.failed) return 'FAILED ' + r.failed;
  if (sc.kind === 'steady') return `all CPU ${r.allCpuPct}%  main thread ${r.cpuPct}% (script ${r.scriptPct} style ${r.stylePct} layout ${r.layoutPct})  per second: style ${r.stylesPerSec} layout ${r.layoutsPerSec} timeouts ${r.timeoutsPerSec} intervals ${r.intervalsPerSec} rAF ${r.rafPerSec} MO ${r.moPerSec} RO ${r.roPerSec}`;
  if (sc.kind === 'rail') return `per click: style recalcs ${r.styles.median} (max ${r.styles.max})  layouts ${r.layouts.median} (max ${r.layouts.max})  main thread ${r.busyMs.median} ms (max ${r.busyMs.max})  longest task ${r.longestTaskMs} ms  dropped ${r.dropped}; one click ${r.oneClick}px, two quick ${r.twoQuickClicks}px, card offsets ${JSON.stringify(r.cardOffsets)}; moved ${JSON.stringify(r.clicks.map(c => c.moved))}`;
  if (sc.kind === 'scroll') return `main thread ${r.cpuPct}% (script ${r.scriptPct} style ${r.stylePct} layout ${r.layoutPct})  style ${r.stylesPerSec}/s layout ${r.layoutsPerSec}/s  MO ${r.moPerSec}/s rAF ${r.rafPerSec}/s  frames p95 ${r.frames.p95} ms max ${r.frames.max} ms slow ${r.frames.slow}/${r.frames.frames}`;
  if (sc.kind === 'change') return `task per change: first ${r.taskMs.first} ms median ${r.taskMs.median} ms max ${r.taskMs.max} ms; grew ${JSON.stringify(r.grew)}`;
  if (sc.kind === 'soak') return `${r.rounds} rounds; per round: ${JSON.stringify(r.perRound)}; first ${JSON.stringify(r.first)}; last ${JSON.stringify(r.last)}; idle after: main ${r.idleAfter.cpuPct}% style ${r.idleAfter.stylesPerSec}/s`;
  return JSON.stringify(r).slice(0, 400);
}

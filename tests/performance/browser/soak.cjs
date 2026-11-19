'use strict';
// A long run: MIKU's page used over and over (every page, albums and artists opened, the queue, the signal card, now
// playing, track changes, the home rails, wheel scrolling) while music plays, for as long as it is asked to.
//
//   node soak.cjs                     60 rounds (about 15 minutes)
//   node soak.cjs --minutes 120       two hours
//   node soak.cjs --rounds 400 --platform mac --theme glass --json soak.json
//
// Every few rounds it reads, after a full garbage collection, what the page still holds: JS heap, DOM nodes, event
// listeners, timers, observed elements, animations, host-event listeners. At the end it reads what the page costs at
// rest again. The run fails (exit code 1) when something kept growing over its second half, when the page costs more
// at rest after the run than before it, or when the page reported an error.
const fs = require('node:fs');
const { launchBrowser, openApp, sleep } = require('./lib/harness.cjs');
const { soak, extension } = require('./scenarios.cjs');
const { SOAK, checkSoak } = require('./budgets.cjs');

(async () => {
  const args = process.argv.slice(2);
  const flag = (name, d) => { const i = args.indexOf(name); return i < 0 ? d : args.splice(i, 2)[1]; };
  const minutes = +flag('--minutes', 0), rounds = +flag('--rounds', 60), every = +flag('--every', 5);
  const platform = flag('--platform', 'windows'), theme = flag('--theme', 'miku'), out = flag('--json', null);
  const modules = String(flag('--modules', '')).split(',').filter(Boolean).map(id => { const x = extension(id); if (!x) throw new Error('module not found: ' + id); return x; });

  const browser = await launchBrowser();
  const app = await openApp(browser, { platform, signal: 'hires', lyrics: 'line', albums: 400, ui: { theme }, extensions: modules });
  console.log(`${platform} page, ${theme} theme, ${minutes ? minutes + ' minutes' : rounds + ' rounds'}, read every ${every} rounds (${browser.version()})`);

  // what the page costs at rest before anything was done to it
  await app.play(); await sleep(6000);
  const idleBefore = await app.measure(5000);
  const t0 = Date.now();
  const cols = ['round', 'heapMB', 'nodes', 'listeners', 'dom', 'intervals', 'timeouts', 'roWatched', 'animations', 'hostListeners'];
  console.log(['min', ...cols].map(c => c.padStart(10)).join(''));
  const result = await soak(app, { rounds, every, minutes, log: h => console.log([((Date.now() - t0) / 60000).toFixed(1), ...cols.map(c => h[c])].map(v => String(v).padStart(10)).join('')) });
  result.idleBefore = Object.fromEntries(Object.keys(result.idleAfter).map(k => [k, idleBefore[k]]));
  result.consoleErrors = app.consoleErrors.slice(0, 10);
  await app.close(); await browser.close();

  console.log('\nper round over the second half: ' + JSON.stringify(result.perRound));
  console.log('at rest before: ' + line(result.idleBefore));
  console.log('at rest after:  ' + line(result.idleAfter));
  const problems = checkSoak(result, SOAK);
  if (out) { fs.writeFileSync(out, JSON.stringify({ ...result, problems }, null, 1)); console.log('saved ' + out); }
  if (problems.length) { console.log('\nFAILED\n - ' + problems.join('\n - ')); process.exit(1); }
  console.log(`\npassed: nothing kept growing over ${result.rounds} rounds, and the page costs the same at rest`);
})().catch(e => { console.error(e); process.exit(1); });

function line(m) { return `main thread ${m.cpuPct}%  per second: style ${m.stylesPerSec} layout ${m.layoutsPerSec} timeouts ${m.timeoutsPerSec} intervals ${m.intervalsPerSec} rAF ${m.rafPerSec} MO ${m.moPerSec}`; }

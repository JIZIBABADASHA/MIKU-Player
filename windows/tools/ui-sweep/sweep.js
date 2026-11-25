#!/usr/bin/env node
/* UI sweep: every theme × day/night × page × window size, checked for cut-off controls, half-visible lines of text and
 * things that overlap (check.js), with a mock host (mock.js) so no player is needed.
 *
 *   node sweep.js --root ../../wwwroot --out /tmp/sweep [--engine webkit|chromium] [--themes poster,gold] [--scen np,home]
 *                 scenarios: home album set homemw np np2 npnl npmw npplain npplainmw (plain = lyrics without timing)
 *                 [--workers 3] [--shots fail|sheet|all] [--platform mac|windows] [--mw path/to/moodchannels.css]
 *
 * Writes <out>/report.json, <out>/summary.txt, a screenshot (JPEG) per failing combination, and with --shots sheet a contact
 * sheet per theme and mode (<out>/sheets/<theme>-<mode>.jpg: the pages down, the window sizes across).
 * Needs the playwright package (npm i playwright; npx playwright install webkit for Safari's engine). */
'use strict';
const fs = require('fs'), path = require('path');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const HERE = __dirname;
const root = path.resolve(arg('root', path.join(HERE, '..', '..', 'wwwroot')));
const outdir = path.resolve(arg('out', path.join(HERE, 'out')));
const engine = arg('engine', 'chromium');
const shots = arg('shots', 'fail');
const platform = arg('platform', process.platform === 'darwin' ? 'mac' : 'windows');
const THEMES = 'flat flat2 glass gold luka miku neon pop poster sakura terminal vinyl washi wood'.split(' ');
const themes = arg('themes', 'all') === 'all' ? THEMES : arg('themes').split(',');
const modes = arg('modes', 'day,night').split(',');
const SIZES = [[2560, 1440], [1920, 1080], [1512, 913], [1440, 900], [1280, 800], [1180, 760], [1100, 700], [980, 640], [1600, 640], [1366, 600], [900, 1200], [760, 900], [800, 600], [2560, 1000]];
const SHEET_SIZES = ['1920x1080', '1512x913', '1280x800', '980x640', '1366x600', '900x1200'];
const sizes = arg('sizes') ? arg('sizes').split(',').map(s => s.split('x').map(Number)) : SIZES;
// MoodWave's channel mode, imitated: its stylesheet, the band on the bar, the channel's dark picture on the bar and page
const mwFile = arg('mw', path.join(HERE, '..', '..', '..', 'Extensions', 'MoodWave', 'miku', 'web', 'moodchannels.css'));
const mwCss = fs.existsSync(mwFile) ? fs.readFileSync(mwFile, 'utf8') : '';
if (!mwCss) console.warn('no MoodWave stylesheet at ' + mwFile + ': the MoodWave pages use only the band and backdrop');
const MW = `(()=>{const s=document.createElement('style');s.textContent=${JSON.stringify(mwCss)};document.head.append(s);
document.documentElement.dataset.extSource='moodchannels';
const e=document.querySelector('#b-ext');e.hidden=false;const b=document.createElement('div');b.className='mc-band';b.style.cssText='width:200px;height:56px;background:rgba(255,255,255,.12);flex:none';e.append(b);
const g=document.createElement('div');g.className='mc-barbg on';g.style.backgroundImage='linear-gradient(100deg,#1b1030,#2a1840 40%,#0e1422)';document.querySelector('#bar').prepend(g);
const p=document.querySelector('#np .np-bg');const d=document.createElement('div');d.className='mc-npbg on';d.style.backgroundImage='linear-gradient(90deg,#101428,#1a1020)';p.append(d);})()`;
const LONG = { title: 'ハッピー・ハッピー・フレンズ', artist: 'わたてん☆5', album: '気ままな天使たち / ハッピー・ハッピー・フレンズ' };
const LONG2 = { title: 'Violin Concerto No. 5 in A major, K. 219 "Turkish": III. Rondeau — Tempo di Menuetto', artist: 'Hilary Hahn, Paavo Järvi, The Deutsche Kammerphilharmonie Bremen', album: 'Mozart 5, Vieuxtemps 4: Violin Concertos' };
const SCEN = {
  home: { hash: '#/home' }, album: { hash: '#/album/a15' }, set: { hash: '#/settings/look' },
  homemw: { hash: '#/home', eval: MW, q: LONG },
  np: { hash: '#/home', np: true, q: LONG }, np2: { hash: '#/home', np: true, q: LONG2 },
  npnl: { hash: '#/home', np: true, q: Object.assign({ ly: '0' }, LONG2) }, npmw: { hash: '#/home', np: true, q: LONG, eval: MW },
  npplain: { hash: '#/home', np: true, q: Object.assign({ lysync: '0' }, LONG) }, npplainmw: { hash: '#/home', np: true, q: Object.assign({ lysync: '0' }, LONG), eval: MW },
};
const scen = (arg('scen', 'all') === 'all' ? Object.keys(SCEN) : arg('scen').split(',')).map(n => Object.assign({ name: n }, SCEN[n]));
const mock = fs.readFileSync(path.join(HERE, 'mock.js'), 'utf8');
const check = fs.readFileSync(path.join(HERE, 'check.js'), 'utf8');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
const hue = s => { let h = 7; for (const c of s) h = (h * 131 + c.charCodeAt(0) * 97) % 3600; return (h * 37) % 360; };
const cover = id => { const h = hue(id), h2 = (h + 50) % 360; return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h} 62% 58%)"/><stop offset="1" stop-color="hsl(${h2} 58% 34%)"/></linearGradient></defs><rect width="400" height="400" fill="url(#g)"/><circle cx="290" cy="120" r="70" fill="hsl(${h2} 70% 78%)" fill-opacity=".55"/></svg>`; };
// transitions and animations finish at once, so every size is measured settled
const STILL = '*,*::before,*::after{transition-duration:0s!important;transition-delay:0s!important;animation-duration:0.001s!important;animation-delay:0s!important;animation-iteration-count:1!important}';

(async () => {
  let pw; try { pw = require('playwright'); } catch (e) { pw = require('playwright-core'); }
  const opts = engine === 'chromium' && fs.existsSync('/usr/bin/google-chrome') ? { executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--font-render-hinting=none'] } : {};
  const browser = await pw[engine].launch(opts);
  fs.mkdirSync(path.join(outdir, 'shots'), { recursive: true });
  const jobs = []; for (const t of themes) for (const m of modes) for (const s of scen) jobs.push({ t, m, s });
  const report = []; let next = 0, done = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const { t, m, s } = jobs[next++];
      const ctx = await browser.newContext({ viewport: { width: sizes[0][0], height: sizes[0][1] }, deviceScaleFactor: 1 });
      const page = await ctx.newPage(); const errs = [];
      page.on('pageerror', e => errs.push(e.message));
      await page.route('**/*', route => {
        const u = new URL(route.request().url());
        if (u.hostname === 'media.miku') { const mm = u.pathname.match(/^\/art\/[^/]+\/(.+)$/); return mm ? route.fulfill({ status: 200, contentType: 'image/svg+xml', body: cover(decodeURIComponent(mm[1])) }) : route.fulfill({ status: 404, body: '' }); }
        if (u.hostname !== 'miku.test') return route.abort();
        let p = decodeURIComponent(u.pathname); if (p === '/') p = '/index.html';
        const f = path.join(root, p);
        if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return route.fulfill({ status: 404, body: '' });
        route.fulfill({ status: 200, contentType: MIME[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
      });
      await page.addInitScript(([ls, mock]) => { try { if (!sessionStorage.getItem('seeded')) { for (const k in ls) localStorage.setItem(k, ls[k]); sessionStorage.setItem('seeded', '1'); } } catch (e) { } (0, eval)(mock); }, [{ 'miku.theme': t, 'miku.mode': m }, mock]);
      const q = new URLSearchParams(Object.assign({ ui: '{}', platform, play: '1', dev: platform === 'mac' ? 'MacBook Pro的揚聲器' : 'Realtek(R) Audio 喇叭' }, s.q || {}));
      try {
        await page.goto(`http://miku.test/index.html?${q}${s.hash || '#/home'}`, { waitUntil: 'load' });
        await page.waitForTimeout(1100);
        if (s.np) { await page.evaluate(() => document.querySelector('#b-art') && document.querySelector('#b-art').click()); await page.waitForTimeout(2600); }
        if (s.eval) { await page.evaluate(s.eval); await page.waitForTimeout(500); }
        await page.addStyleTag({ content: STILL });
        for (const [w, h] of sizes) {
          await page.setViewportSize({ width: w, height: h });
          await page.waitForTimeout(700);
          const issues = await page.evaluate(check);
          const name = `${t}-${m}-${s.name}-${w}x${h}`;
          if (issues.length || shots === 'all' || (shots === 'sheet' && SHEET_SIZES.includes(w + 'x' + h))) await page.screenshot({ path: path.join(outdir, 'shots', name + '.jpg'), type: 'jpeg', quality: 80 });
          report.push({ name, t, m, s: s.name, w, h, issues });
        }
      } catch (e) { report.push({ name: `${t}-${m}-${s.name}`, t, m, s: s.name, error: String(e) }); }
      if (errs.length) report.push({ name: `${t}-${m}-${s.name}`, t, m, s: s.name, pageerrors: [...new Set(errs)].slice(0, 5) });
      await ctx.close();
      if (++done % 8 === 0) process.stderr.write(`${done}/${jobs.length}\n`);
    }
  };
  await Promise.all(Array.from({ length: +arg('workers', 3) }, worker));
  fs.writeFileSync(path.join(outdir, 'report.json'), JSON.stringify(report, null, 1));
  const bad = report.filter(r => (r.issues && r.issues.length) || r.error || r.pageerrors);
  const lines = [`engine ${engine}, platform ${platform}, ${report.filter(r => r.issues).length} combinations checked, ${bad.length} with problems`, ''];
  for (const r of bad) lines.push(r.name + ': ' + (r.error || (r.pageerrors && r.pageerrors.join(' | ')) || r.issues.map(i => `${i.kind} ${i.el} (${i.detail})`).join('; ')));
  fs.writeFileSync(path.join(outdir, 'summary.txt'), lines.join('\n') + '\n');
  console.log(lines[0]);
  // contact sheets, drawn by the browser itself (no image library needed)
  if (shots === 'sheet' || shots === 'all') {
    fs.mkdirSync(path.join(outdir, 'sheets'), { recursive: true });
    const page = await (await browser.newContext({ viewport: { width: 2400, height: 800 }, deviceScaleFactor: 1 })).newPage();
    for (const t of themes) for (const m of modes) {
      const rows = scen.map(s => `<tr><th>${s.name}</th>${SHEET_SIZES.map(z => {
        const f = path.join(outdir, 'shots', `${t}-${m}-${s.name}-${z}.jpg`), r = report.find(x => x.name === `${t}-${m}-${s.name}-${z}`);
        const n = r && r.issues ? r.issues.length : 0;
        return fs.existsSync(f) ? `<td class="${n ? 'bad' : ''}"><img src="data:image/jpeg;base64,${fs.readFileSync(f).toString('base64')}"><div>${z}${n ? ' — ' + n + ' problem(s)' : ''}</div></td>` : '<td></td>';
      }).join('')}</tr>`).join('');
      await page.setContent(`<!doctype html><style>body{margin:0;background:#222;color:#eee;font:13px system-ui}table{border-collapse:collapse}th{writing-mode:vertical-rl;padding:4px}td{padding:4px;vertical-align:top}img{width:560px;display:block;border:1px solid #555}td.bad img{border:3px solid #f33}h1{font-size:18px;margin:8px}</style><h1>${t} · ${m} · ${engine}</h1><table>${rows}</table>`);
      await page.waitForTimeout(100);
      await page.screenshot({ path: path.join(outdir, 'sheets', `${t}-${m}.jpg`), fullPage: true, type: 'jpeg', quality: 82 });
    }
  }
  await browser.close();
  process.exit(0);
})();

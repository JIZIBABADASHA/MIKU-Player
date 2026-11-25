#!/usr/bin/env node
/* UI sweep: every theme × day/night × page × window size, checked for cut-off controls, half-visible lines of text and
 * things that overlap (check.js), with a mock host (mock.js) so no player is needed.
 *
 *   node sweep.js --root ../../wwwroot --out /tmp/sweep [--engine webkit|chromium] [--themes poster,gold] [--scen np,home]
 *                 scenarios: home album set homemw homeradio np np2 npnl npmw npradio npplain npplainmw
 *                 (mw = a MoodWave channel, radio = a MoodWave station, plain = lyrics without timing)
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
// MoodWave's channel mode, imitated: its stylesheet, the band on the bar, the channel's dark picture on the bar and page,
// and the channel wheel at the left of now playing (its names are in the theme's font: a wide one cut "Shuffle All").
// The band comes in as in the app: MIKU swaps the bar's left part as a whole (core.js BarSwap: a copy of the old one over
// it, the new one sliding in from the edge). Measured on the way, the bar once went as compact as it can and stayed so.
const mwFile = arg('mw', path.join(HERE, '..', '..', '..', 'Extensions', 'MoodWave', 'miku', 'web', 'moodchannels.css'));
const mwCss = fs.existsSync(mwFile) ? fs.readFileSync(mwFile, 'utf8') : '';
if (!mwCss) console.warn('no MoodWave stylesheet at ' + mwFile + ': the MoodWave pages use only the band and backdrop');
const MW = `(()=>{const s=document.createElement('style');s.textContent=${JSON.stringify(mwCss)};document.head.append(s);
document.documentElement.dataset.extSource='moodchannels';
const go=typeof BarSwap!=='undefined'?BarSwap.begin():null;
const e=document.querySelector('#b-ext');e.hidden=false;const b=document.createElement('div');b.className='mc-band';${mwCss ? "" : "b.style.cssText='width:200px;height:68px;flex:none';"}
const arrow='<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 9l6 6 6-6"/></svg>';
b.innerHTML='<button class="mc-band-step" title="上一個頻道">'+arrow+'</button><span class="mc-band-name" role="link" tabindex="0"><span class="mc-roll"><span class="mc-roll-item"><i class="mc-band-logo" style="display:block;background:#fff;border-radius:50%"></i><span>Energetic</span></span></span></span><button class="mc-band-step down" title="下一個頻道">'+arrow+'</button><div class="mc-votes"><button class="mc-vote" title="不喜歡">'+arrow+'</button><button class="mc-vote" title="喜歡">'+arrow+'</button></div>';
e.append(b);
const fitBand=()=>{const mini=b.closest('.np-mini'),art=mini&&mini.querySelector('.art');const room=mini?mini.clientWidth-120-(art?art.offsetWidth:0)-28:999;const t=room-76<90;b.classList.toggle('mc-tight',t);b.style.width=(t?120:196)+'px'};
fitBand();addEventListener('resize',()=>setTimeout(fitBand,60));
const g=document.createElement('div');g.className='mc-barbg on';g.style.backgroundImage='linear-gradient(100deg,#1b1030,#2a1840 40%,#0e1422)';document.querySelector('#bar').prepend(g);
const p=document.querySelector('#np .np-bg');const d=document.createElement('div');d.className='mc-npbg on';d.style.backgroundImage='linear-gradient(90deg,#101428,#1a1020)';p.append(d);
const n=document.querySelector('#np-ext');n.hidden=false;const r=document.createElement('div');r.className='mc-rail';
r.innerHTML='<a class="mc-rail-head"><i class="mc-rail-logo" style="display:block;background:#fff;border-radius:50%"></i><span class="mc-brand">MoodWave</span></a><button class="mc-rail-step">'+arrow+'</button><div class="mc-wheel"><div class="mc-votes"><button class="mc-vote yes">'+arrow+'</button><button class="mc-vote no">'+arrow+'</button></div>'+['Extreme','Shuffle All','Morning','Energetic','Relax','Mellow','Upbeat'].map((x,k)=>'<button class="mc-rail-item'+(k===3?' on':'')+'" style="--o:'+(k-3)+';--a:'+Math.abs(k-3)+';--sc:'+(k===3?1:.8)+';--art:linear-gradient(135deg,#456,#a67)"><i class="mc-rail-art"></i><span class="mc-rail-text"><b>'+x+'</b><small>充滿活力・節奏強烈</small></span></button>').join('')+'</div><button class="mc-rail-step down">'+arrow+'</button>';
n.append(r);if(go)go();})()`;
// MoodWave's radio (a station, not a channel): the page keeps the theme; a station label on the bar and, on wide pages,
// a station rail at the left of now playing
const MWR = `(()=>{const s=document.createElement('style');s.textContent=${JSON.stringify(mwCss)};document.head.append(s);
const r=document.documentElement;r.dataset.extSource='moodchannels';r.classList.add('mc-radio');
const e=document.querySelector('#b-ext');e.hidden=false;const b=document.createElement('div');b.className='mc-radio-band';b.innerHTML='<span class="mc-radio-mark"><i class="mc-logo" style="display:block;background:#888;border-radius:50%"></i></span><span class="mc-radio-text"><small>MoodWave 電台</small><b>Energetic</b></span>';e.append(b);
const n=document.querySelector('#np-ext');n.hidden=false;const rl=document.createElement('div');rl.className='mc-radio-rail';rl.innerHTML='<span class="mc-radio-mark"><i class="mc-logo" style="display:block;background:#888;border-radius:50%"></i></span><span class="mc-radio-text"><small>MoodWave 電台</small><b>Energetic</b></span>';n.append(rl);})()`;
const TITLE = arg('title');
const LONG = TITLE ? { title: TITLE, artist: arg('artist', 'ヨルシカ'), album: arg('album', '盗作') } : { title: 'ハッピー・ハッピー・フレンズ', artist: 'わたてん☆5', album: '気ままな天使たち / ハッピー・ハッピー・フレンズ' };
const LONG2 = { title: 'Violin Concerto No. 5 in A major, K. 219 "Turkish": III. Rondeau — Tempo di Menuetto', artist: 'Hilary Hahn, Paavo Järvi, The Deutsche Kammerphilharmonie Bremen', album: 'Mozart 5, Vieuxtemps 4: Violin Concertos' };
const SCEN = {
  home: { hash: '#/home', q: { rl: '1' } }, album: { hash: '#/album/a15' }, set: { hash: '#/settings/look' },
  homemw: { hash: '#/home', eval: MW, q: LONG },
  np: { hash: '#/home', np: true, q: LONG }, np2: { hash: '#/home', np: true, q: LONG2 },
  npnl: { hash: '#/home', np: true, q: Object.assign({ ly: '0' }, LONG2) }, npmw: { hash: '#/home', np: true, q: LONG, eval: MW },
  homeradio: { hash: '#/home', eval: MWR, q: LONG }, npradio: { hash: '#/home', np: true, q: LONG, eval: MWR },
  npplain: { hash: '#/home', np: true, q: Object.assign({ lysync: '0' }, LONG) }, npplainmw: { hash: '#/home', np: true, q: Object.assign({ lysync: '0' }, LONG), eval: MW },
};
const scen = (arg('scen', 'all') === 'all' ? Object.keys(SCEN) : arg('scen').split(',')).map(n => Object.assign({ name: n }, SCEN[n]));
const mock = fs.readFileSync(path.join(HERE, 'mock.js'), 'utf8');
// text too faint to read, from the pixels (contrast.js): at these sizes (the full sidebar, the folded one, the two-row bar)
const contrast = fs.readFileSync(path.join(HERE, 'contrast.js'), 'utf8');
const FAINT = +arg('faint', 2.05), FAINT_SIZES = ['1512x913', '1100x700', '980x640'];
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
        if (s.np) {
          await page.evaluate(() => document.querySelector('#b-art') && document.querySelector('#b-art').click()); await page.waitForTimeout(2600);
          // the page slides up: on a slow machine (glass at 2560x1440 without a GPU) it was still on its way after 2.6 s
          await page.waitForFunction(() => { const c = document.querySelector('#np-cover'); if (!c) return true; const r = c.getBoundingClientRect(), k = Math.round(r.top) + ':' + Math.round(r.left), same = window.__npAt === k; window.__npAt = k; return same && r.bottom < innerHeight + 5; }, null, { polling: 300, timeout: 12000 }).catch(() => { });
        }
        // the swap of the bar's left part runs on frames: wait for it to end (a slow machine draws few), then let things settle
        if (s.eval) { await page.evaluate(s.eval); await page.waitForTimeout(600); await page.waitForFunction(() => typeof BarSwap === 'undefined' || !BarSwap.cur, null, { timeout: 10000 }).catch(() => { }); await page.waitForTimeout(500); }
        await page.addStyleTag({ content: STILL });
        for (const [w, h] of sizes) {
          await page.setViewportSize({ width: w, height: h });
          await page.waitForTimeout(700);
          const issues = await page.evaluate(check);
          if (FAINT > 0 && FAINT_SIZES.includes(w + 'x' + h)) {
            const png = await page.screenshot({ type: 'png' });
            for (const x of await page.evaluate(`(${contrast})(${JSON.stringify(png.toString('base64'))}, ${FAINT})`)) issues.push({ kind: 'faint', el: x.el + ' "' + x.text + '"', detail: 'contrast ' + x.ratio + ':1' });
          }
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

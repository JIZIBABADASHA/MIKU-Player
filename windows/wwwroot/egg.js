'use strict';
/* The logo's secret: click the MIKU wordmark in the sidebar and something enormous comes for it. A wall of data — hex
   words, bit streams, sample values, rates, meters, as tall as the window — moves in from the far side, slowly, and
   nothing stops it: the window trembles, the logo strains and cracks as the wall's edge reaches it, then bursts, and
   its pieces rain down and lie scattered on the floor of the window. They stay there until the logo's place is
   clicked again, when they rise, whirl and lock back together with a flash. Nothing is saved: a broken logo is whole
   again the next time MIKU starts. With 輕量化「頁面與操作動畫」 (or reduced motion) the logo only changes between
   broken and whole. */
const LogoEgg = {
  broken: false, busy: false, shards: null,
  calm: () => matchMedia('(prefers-reduced-motion: reduce)').matches || (typeof PageEffects !== 'undefined' && PageEffects.reduced('page')),
  /** The wall: columns of data running up and down at their own pace, meters between them, a bright edge in front. */
  wall(width) {
    const hex = n => Array.from({ length: n }, () => '0123456789ABCDEF'[Math.random() * 16 | 0]).join('');
    const bits = n => Array.from({ length: n }, () => Math.random() < .5 ? '0' : '1').join('');
    const pick = a => a[Math.random() * a.length | 0];
    const words = [
      () => '0x' + hex(6), () => bits(16), () => (Math.random() * 2 - 1).toFixed(6), () => pick(['44100', '48000', '88200', '96000', '176400', '192000', '352800', '705600', '2822400', '5644800']) + ' Hz',
      () => pick(['16', '24', '32']) + '-bit', () => 'FFT[' + (1 << (8 + (Math.random() * 6 | 0))) + ']', () => (-Math.random() * 96).toFixed(2) + ' dBFS', () => pick(['DSD64', 'DSD128', 'DoP 05/FA', 'PCM', 'FLAC', 'SYNC', 'LOCK', 'CRC ' + hex(4), 'Δ-Σ 8', 'TPDF', 'HOG', 'RING ' + hex(2)]),
      () => hex(2) + ' ' + hex(2) + ' ' + hex(2) + ' ' + hex(2), () => 'ch' + (Math.random() * 2 | 0) + ' ' + hex(8), () => '#' + String(Math.random() * 1e7 | 0).padStart(7, '0'),
    ];
    const el = document.createElement('div');
    el.className = 'egg-wall';
    const cols = Math.max(8, Math.round(width / 118));
    for (let c = 0; c < cols; c++) {
      if (c % 4 === 2) {   // a meter: bars that never rest
        const m = document.createElement('div'); m.className = 'egg-meter';
        for (let b = 0; b < 46; b++) { const i = document.createElement('i'); i.style.cssText = `animation-duration:${(.35 + Math.random() * .9).toFixed(2)}s;animation-delay:${(-Math.random()).toFixed(2)}s;--w:${(20 + Math.random() * 80).toFixed(0)}%`; m.append(i); }
        el.append(m); continue;
      }
      const col = document.createElement('div');
      col.className = 'egg-col' + (c % 5 === 0 ? ' pink' : c % 3 === 0 ? ' dim' : '');
      const lines = Array.from({ length: 70 }, () => pick(words)()).join('\n');
      const run = document.createElement('pre');
      run.textContent = lines + '\n' + lines;   // twice: the loop has no seam
      run.style.animationDuration = (9 + Math.random() * 16).toFixed(1) + 's';
      if (c % 2) run.style.animationDirection = 'reverse';
      col.append(run); el.append(col);
    }
    const edge = document.createElement('div'); edge.className = 'egg-edge';
    el.append(edge);
    return el;
  },
  init() {
    const brand = document.getElementById('brand');
    if (!brand || brand._egg) return;
    brand._egg = true; brand.style.cursor = 'pointer';
    brand.addEventListener('click', () => {
      if (this.busy) return;
      // the sidebar drew the logo again (another theme, a resize): it is whole
      if (this.broken && !(this.shards && this.shards.isConnected)) { this.broken = false; brand.classList.remove('egg-broken'); }
      this.broken ? this.revive(brand) : this.crush(brand);
    });
  },
  spark(x, y, n, colors, spread) {
    for (let i = 0; i < n; i++) {
      const s = document.createElement('i');
      s.className = 'egg-spark';
      const a = Math.random() * Math.PI * 2, d = spread * (.45 + Math.random() * .55), size = 4 + Math.random() * 7;
      s.style.cssText = `left:${x}px;top:${y}px;width:${size}px;height:${size}px;background:${colors[i % colors.length]}`;
      document.body.append(s);
      s.animate([{ transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
        { transform: `translate(calc(-50% + ${Math.cos(a) * d}px), calc(-50% + ${Math.sin(a) * d + d * .35}px)) scale(.2) rotate(${Math.random() * 540}deg)`, opacity: 0 }],
        { duration: 520 + Math.random() * 480, easing: 'cubic-bezier(.1,.7,.3,1)' }).onfinish = () => s.remove();
    }
  },
  /** The floor the pieces land on: the top of the player bar. */
  floor() { const bar = document.getElementById('bar'); return (bar ? bar.getBoundingClientRect().top : innerHeight) - 5; },
  /** The logo cut into irregular triangles (a jittered grid), each a copy of the wordmark behind its own clip, in a
   *  layer over the page so the pieces can leave the sidebar. */
  shatter(logo) {
    const r = logo.getBoundingClientRect(), w = r.width, hgt = r.height;
    const cols = 9, rows = 4, pts = [];
    for (let y = 0; y <= rows; y++) for (let x = 0; x <= cols; x++) {
      const edge = y === 0 || y === rows || x === 0 || x === cols;
      pts.push([x * w / cols + (edge ? 0 : (Math.random() - .5) * w / cols * .75), y * hgt / rows + (edge ? 0 : (Math.random() - .5) * hgt / rows * .75)]);
    }
    const box = document.createElement('div');
    box.className = 'egg-shards';
    box.style.cssText = `left:${r.left}px;top:${r.top}px;width:${w}px;height:${hgt}px`;
    const at = (y, x) => pts[y * (cols + 1) + x], floor = this.floor(), reach = Math.max(r.right + 40, innerWidth * .62);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const q = [at(y, x), at(y, x + 1), at(y + 1, x + 1), at(y + 1, x)];
      for (const tri of (y + x) % 2 ? [[q[0], q[1], q[2]], [q[0], q[2], q[3]]] : [[q[0], q[1], q[3]], [q[1], q[2], q[3]]]) {
        const s = document.createElement('div');
        s.className = 'egg-shard';
        const cx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3, cy = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;
        s.style.clipPath = `polygon(${tri.map(p => `${p[0].toFixed(1)}px ${p[1].toFixed(1)}px`).join(',')})`;
        s.style.transformOrigin = `${cx.toFixed(1)}px ${cy.toFixed(1)}px`;
        s.append(logo.cloneNode(true));
        s._x = cx / w;
        // strained: a crack's width out of place
        s._crack = `translate(${((Math.random() - .5) * 5).toFixed(1)}px, ${((Math.random() - .5) * 4).toFixed(1)}px) rotate(${((Math.random() - .5) * 7).toFixed(1)}deg)`;
        // where it lands: thrown out across the floor (some far), turned any way up
        const far = Math.random() < .3;
        const fx = Math.min(reach, Math.max(10, r.left + cx + (far ? 120 + Math.random() * (reach - r.left) : (Math.random() - .35) * 210)));
        s._dx = fx - (r.left + cx); s._dy = floor - Math.random() * 9 - (r.top + cy);
        s._rot = (Math.random() - .5) * 1400; s._up = 90 + Math.random() * 260; s._scale = .85 + Math.random() * .5;
        s._rest = `translate(${s._dx.toFixed(1)}px, ${s._dy.toFixed(1)}px) rotate(${s._rot.toFixed(0)}deg) scale(${s._scale.toFixed(2)})`;
        box.append(s);
      }
    }
    document.body.append(box);
    return box;
  },
  /** Thrown up and out, down under its own weight, one bounce on the floor. */
  fall(s) {
    const frames = [];
    for (let k = 0; k <= 9; k++) {
      const t = k / 9, land = .82, u = Math.min(1, t / land);
      let y = -s._up * u + (s._dy + s._up) * u * u;                       // up first, then gravity
      if (t > land) { const b = (t - land) / (1 - land); y = s._dy - 26 * Math.sin(Math.PI * b) * (1 - b * .4); }
      frames.push({ offset: t, transform: `translate(${(s._dx * Math.min(1, t * 1.08)).toFixed(1)}px, ${y.toFixed(1)}px) rotate(${(s._rot * Math.min(1, t * 1.1)).toFixed(0)}deg) scale(${(1 + (s._scale - 1) * t).toFixed(2)})` });
    }
    frames[frames.length - 1].transform = s._rest;
    return frames;
  },
  async crush(brand) {
    const logo = brand.querySelector('svg.wm'); if (!logo) return;
    this.broken = true;
    const box = this.shards = this.shatter(logo);
    const pieces = [...box.children];
    brand.classList.add('egg-broken');
    if (this.calm() || !logo.animate) { pieces.forEach(s => { s.style.transform = s._rest; }); return; }
    this.busy = true;
    const r = logo.getBoundingClientRect(), lx = r.left + r.width / 2, ly = r.top + r.height / 2;
    // the wall: as tall as the window and more than half as wide, from beyond the right edge all the way across and out
    // on the left — slowly, at one steady pace. The logo, in the far corner, is the last thing it reaches.
    const W = Math.max(520, innerWidth * .62), total = innerWidth + W, ms = 9000;
    const disc = this.wall(W);
    disc.style.cssText = `left:${innerWidth}px;top:0;width:${W}px;height:${innerHeight}px`;
    document.body.append(disc);
    const roll = disc.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${-total}px)` }], { duration: ms, easing: 'linear', fill: 'forwards' });
    // the ground shakes the whole time it rolls, harder while it is on the logo
    const app = document.getElementById('app') || document.body;
    const rumble = app.animate([[0, 0], [1.2, -1], [-1, 1.4], [.8, .9], [-1.3, -.6], [0, 0]].map(([x, y]) => ({ transform: `translate(${x}px, ${y}px)` })), { duration: 150, iterations: Infinity });
    const edge = ms * (innerWidth - r.right - 6) / total;      // the wall's edge reaches the logo
    const wait = t => new Promise(done => setTimeout(done, t));
    // 1. it looms: the logo trembles
    await wait(Math.max(0, edge - 900));
    const tremble = box.animate([[0, 0], [1.5, -1], [-1.5, 1], [1, 1.5], [-1, -1.5], [0, 0]].map(([x, y]) => ({ transform: `translate(${x}px, ${y}px)` })), { duration: 90, iterations: Infinity });
    await wait(900);
    // 2. the edge is on it: it is pressed in and cracks, piece by piece, from the side the wall comes from
    pieces.forEach(s => s.animate([{ transform: 'none' }, { transform: s._crack }], { duration: 160, delay: (1 - s._x) * 520 + Math.random() * 120, easing: 'ease-out', fill: 'both' }));
    box.animate([{ transform: 'scale(1,1)' }, { transform: 'scale(.82,1.05)' }], { duration: 760, easing: 'cubic-bezier(.5,0,.9,.4)', fill: 'forwards' });
    this.spark(r.right - 6, ly, 10, ['#ffffff', '#39c5bb'], 60);
    rumble.playbackRate = 1.8;
    await wait(780);
    // 3. it gives way: the pieces burst out in front of the wall and come down all over the floor
    tremble.cancel();
    box.classList.add('egg-out');
    box.getAnimations().forEach(a => a.cancel());
    this.spark(lx, ly, 46, ['#39c5bb', '#e5307e', '#ffffff', '#1c1c20'], 230);
    app.animate([0, 14, -11, 8, -5, 3, 0].map(y => ({ transform: `translate(${y * .5}px, ${y}px)` })), { duration: 620, easing: 'ease-out' });
    const falls = pieces.map(s => {
      s.getAnimations().forEach(a => a.cancel());
      return s.animate(this.fall(s), { duration: 1150 + Math.random() * 700, delay: Math.random() * 140, easing: 'linear', fill: 'both' }).finished;
    });
    try { await Promise.all(falls); } catch { }
    pieces.forEach(s => { s.style.transform = s._rest; });
    rumble.playbackRate = 1;
    // 4. and the wall moves on, as slowly as it came
    try { await roll.finished; } catch { }
    rumble.cancel(); disc.remove();
    this.busy = false;
  },
  async revive(brand) {
    const box = this.shards, logo = brand.querySelector('svg.wm');
    this.broken = false;
    const done = () => { box && box.remove(); this.shards = null; brand.classList.remove('egg-broken'); };
    if (!box || !logo || this.calm() || !logo.animate) { done(); return; }
    this.busy = true;
    const r = logo.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const pieces = [...box.children];
    box.classList.add('egg-out');
    // up off the floor in a whirl, then every piece home at once
    const all = pieces.map((s, i) => {
      const a = Math.random() * Math.PI * 2, d = 50 + Math.random() * 90;
      return s.animate([
        { transform: s._rest, filter: 'brightness(1)' },
        { transform: `translate(${(s._dx * .55 + Math.cos(a) * d).toFixed(0)}px, ${(s._dy * .35 + Math.sin(a) * d - 30).toFixed(0)}px) rotate(${(Math.random() - .5) * 900}deg) scale(1.25)`, filter: 'brightness(2.2) drop-shadow(0 0 6px #39c5bb)', offset: .5 },
        { transform: 'translate(0,0) rotate(720deg) scale(1.08)', filter: 'brightness(1.7) drop-shadow(0 0 8px #e5307e)', offset: .88 },
        { transform: 'translate(0,0) rotate(720deg) scale(1)', filter: 'brightness(1)' },
      ], { duration: 1250, delay: i * 6, easing: 'cubic-bezier(.3,.7,.2,1)', fill: 'both' }).finished;
    });
    try { await Promise.all(all); } catch { }
    done();
    const ring = document.createElement('i');
    ring.className = 'egg-ring'; ring.style.cssText = `left:${cx}px;top:${cy}px`;
    document.body.append(ring);
    ring.animate([{ transform: 'translate(-50%,-50%) scale(.1)', opacity: .95 }, { transform: 'translate(-50%,-50%) scale(7)', opacity: 0 }], { duration: 700, easing: 'cubic-bezier(.1,.6,.2,1)' }).onfinish = () => ring.remove();
    this.spark(cx, cy, 34, ['#39c5bb', '#e5307e', '#ffffff', '#ffe66d'], 190);
    const pop = logo.animate([{ transform: 'scale(1.22)', filter: 'brightness(2) drop-shadow(0 0 16px #39c5bb)' }, { transform: 'scale(.96)', filter: 'brightness(1.2) drop-shadow(0 0 8px #e5307e)', offset: .6 }, { transform: 'scale(1)', filter: 'none' }],
      { duration: 420, easing: 'cubic-bezier(.2,.8,.3,1)' });
    try { await pop.finished; } catch { }
    this.busy = false;
  },
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => LogoEgg.init()); else LogoEgg.init();

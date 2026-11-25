'use strict';
/* 暴發戶黃金 (gold) only: the interface sprays gold coins, a lot of them, and golden glints flash all over the window.
 *
 * Gold coins spin with a glint and bounce on the bottom edge (twice, then drop away):
 *   - pressing play (the bar's or Now Playing's play button)  → a jackpot: two fountains out of the play button + a downpour
 *   - another track                                            → a downpour + a fountain out of the cover
 *   - a click on a button or a card                            → a burst where it was clicked
 *   - each new current lyric line in Now Playing ('miku-lyric-line') → a shower over the lyrics column, and coins popping
 *     out of both ends of the line; every 4th line is a jackpot. Whatever crosses the current line fades almost away
 *     there (it seems to pass behind it), so the line being sung is never covered.
 *   - while a song plays, every 7–12 s a shower somewhere along the top of the window
 * Glints: about twenty-five little four-point stars that flash one after another at random places (on the cards, buttons,
 * titles, the player bar, or anywhere), each a CSS layer animated with the Web Animations API (transform and opacity
 * only, so the compositor draws them and the page is never laid out or repainted for them).
 *
 * Cost: one fixed canvas (pointer-events: none) above the page, Now Playing and the player bar, under drawers, menus,
 * dialogs and toasts. At most 520 coins alive; the sprites (two coin faces, the rim, the glint) are drawn once and
 * stamped with drawImage. requestAnimationFrame runs only while something is in the air (≤ ~60 draws a second on fast
 * screens, only the area last drawn is cleared); when the last one is gone the canvas is hidden, and its pixels are
 * freed 4 s later. Nothing at all while the window is hidden. Outside 暴發戶黃金, under 輕量化頁面 › 關閉動態背景
 * (lite-ambient) and with reduced motion this file only watches for the theme / setting to change: no canvas, no glints,
 * no listeners, no timers.
 * The art is generic and made up (no real currency): "$" coins and square-holed cash coins 「招財進寶」.
 */
(() => {
  const THEME = 'gold', MAX = 520, root = document.documentElement;
  const reduceMq = matchMedia('(prefers-reduced-motion: reduce)');
  const allowed = () => root.dataset.theme === THEME && !reduceMq.matches && !root.classList.contains('lite-ambient')
    && !(typeof PageEffects !== 'undefined' && PageEffects.reduced('ambient'));
  const hidden = () => document.hidden || (typeof IdleFx !== 'undefined' && IdleFx.hidden);
  const rnd = (a, b) => a + Math.random() * (b - a);
  const sign = () => (Math.random() < .5 ? -1 : 1);
  const bootUntil = performance.now() + 2000;   // the first states at start-up are not a press of play / a new track

  const COIN = 1, STAR = 2;
  const CD = 30, SD = 22;                          // coin and glint sizes (CSS px, scale 1)
  const GC = 1550;                                 // gravity for coins
  const CLICKABLE = 'button, a, [role="button"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"], .card';
  const SERIF = 'Georgia, "Times New Roman", serif';
  const CJK = '"Microsoft JhengHei UI", "Microsoft JhengHei", "PingFang TC", "Hiragino Sans", "Noto Sans CJK TC", "WenQuanYi Zen Hei", sans-serif';

  let armed = false, cv = null, g = null, W = 0, H = 0, DPR = 1, SS = 0, spr = null, sized = false;
  let raf = 0, last = 0, freeTimer = 0, welcomeTimer = 0, showerTimer = 0, box = null;   // box: the area drawn last frame (device px)
  let band = null, bandEl = null, lastClick = 0, lastLine = 0, lineCount = 0, lastTitle = null, wasPaused = false;
  let bodyObs = null, titleObs = null;
  const live = [], spare = [], queue = [];

  /* ── sprites, drawn once per pixel ratio ── */
  function sheet(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.ceil(w * SS); c.height = Math.ceil(h * SS); c.cw = w; c.ch = h;
    const x = c.getContext('2d'); x.scale(SS, SS);
    return [c, x];
  }
  function rr(x, l, t, w, h, r) { x.beginPath(); if (x.roundRect) x.roundRect(l, t, w, h, r); else x.rect(l, t, w, h); }
  function text(x, s, px, cx, cy, fill, weight) {
    x.font = `${weight || 'bold'} ${px}px ${/^[\x20-\x7e]+$/.test(s) ? SERIF : CJK}`;
    x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillStyle = fill; x.fillText(s, cx, cy);
  }
  function mkCoin(kind) {   // 0: "$" coin, 1: square-holed cash coin 「招財進寶」, 2: the rim seen from the side (darker)
    const D = CD, R = D / 2 - .6, [c, x] = sheet(D + 2, D + 2);
    x.translate(1 + D / 2, 1 + D / 2);
    if (kind === 2) {
      const e = x.createLinearGradient(-R, 0, R, 0);
      e.addColorStop(0, '#7a4c00'); e.addColorStop(.5, '#d79f22'); e.addColorStop(1, '#7a4c00');
      x.beginPath(); x.arc(0, 0, R, 0, 7); x.fillStyle = e; x.fill(); x.lineWidth = 1; x.strokeStyle = '#4e3000'; x.stroke();
      return c;
    }
    const f = x.createRadialGradient(-R * .35, -R * .42, 1, 0, 0, R * 1.15);
    f.addColorStop(0, '#fffbe4'); f.addColorStop(.3, '#ffe072'); f.addColorStop(.72, '#e8af27'); f.addColorStop(1, '#a36a06');
    x.beginPath(); x.arc(0, 0, R, 0, 7); x.fillStyle = f; x.fill(); x.lineWidth = 1.2; x.strokeStyle = '#5e3b00'; x.stroke();
    x.beginPath(); x.arc(0, 0, R - 2.7, 0, 7); x.lineWidth = 1; x.strokeStyle = 'rgba(255,246,196,.95)'; x.stroke();
    x.beginPath(); x.arc(0, 0, R - 3.7, 0, 7); x.lineWidth = .8; x.strokeStyle = 'rgba(110,68,0,.6)'; x.stroke();
    if (kind === 0) {
      text(x, '$', 17, -.7, .1, '#fff7cc');
      text(x, '$', 17, 0, .8, '#7d4f00');
    } else {
      const s = 4.2;
      x.save(); x.globalCompositeOperation = 'destination-out'; x.fillRect(-s, -s, s * 2, s * 2); x.restore();
      x.lineWidth = 1; x.strokeStyle = '#5e3b00'; x.strokeRect(-s - .5, -s - .5, s * 2 + 1, s * 2 + 1);
      x.strokeStyle = 'rgba(255,246,196,.9)'; x.strokeRect(-s - 1.6, -s - 1.6, s * 2 + 3.2, s * 2 + 3.2);
      [['招', 0, -8], ['財', 8, 0], ['進', 0, 8], ['寶', -8, 0]].forEach(([ch, cx, cy]) => text(x, ch, 5.2, cx, cy + .3, '#7d4f00'));
    }
    return c;
  }
  function mkStar() {
    const S = SD, [c, x] = sheet(S, S);
    x.translate(S / 2, S / 2);
    const r = x.createRadialGradient(0, 0, 0, 0, 0, S / 2);
    r.addColorStop(0, 'rgba(255,255,244,1)'); r.addColorStop(.16, 'rgba(255,240,170,.9)'); r.addColorStop(.42, 'rgba(255,214,90,.28)'); r.addColorStop(1, 'rgba(255,200,60,0)');
    x.beginPath(); x.arc(0, 0, S / 2, 0, 7); x.fillStyle = r; x.fill();
    const a = S / 2, b = 1.25;
    x.beginPath(); x.moveTo(0, -a); x.lineTo(b, -b); x.lineTo(a, 0); x.lineTo(b, b); x.lineTo(0, a); x.lineTo(-b, b); x.lineTo(-a, 0); x.lineTo(-b, -b); x.closePath();
    x.fillStyle = '#fffbea'; x.fill();
    return c;
  }
  function sprites() {
    if (spr) return spr;
    spr = { coins: [mkCoin(0), mkCoin(1)], rim: mkCoin(2), star: mkStar() };
    return spr;
  }

  /* ── the overlay ── */
  function size() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth; H = window.innerHeight;
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    const ss = DPR * 1.3;   // sprites a little sharper than the screen: coins are drawn up to 1.3×
    if (ss !== SS) { SS = ss; spr = null; sprites(); }   // moved to a screen with another pixel ratio: redrawn at once (frames use them)
    sized = true; box = null;
  }
  /** Canvas, size and sprites, made the first time something is thrown (not when the theme is merely on). */
  function ready() {
    if (!armed || !allowed() || hidden()) return false;
    if (!cv) {
      cv = document.createElement('canvas');
      cv.id = 'gold-fx'; cv.setAttribute('aria-hidden', 'true');
      cv.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;z-index:60;pointer-events:none;contain:strict;display:none';
      document.body.append(cv);
      g = cv.getContext('2d');
    }
    if (!sized) size();
    sprites();
    return true;
  }
  function kick() {
    if (raf || !cv || (!live.length && !queue.length)) return;
    clearTimeout(freeTimer);
    cv.style.display = '';
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
  /** Nothing left in the air: hide the canvas (no layer to composite) and free its pixels a little later. */
  function idle() {
    if (g) { g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cv.width, cv.height); }
    box = null;
    if (cv) cv.style.display = 'none';
    clearTimeout(freeTimer);
    freeTimer = setTimeout(() => { if (!raf && cv) { cv.width = cv.height = 0; sized = false; } }, 4000);
  }
  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    while (live.length) spare.push(live.pop());
    queue.length = 0;
    idle();
  }

  /* ── particles ── */
  function add(k, x, y, vx, vy, s, life) {
    if (live.length >= MAX) return null;
    const p = spare.pop() || {};
    p.k = k; p.x = x; p.y = y; p.vx = vx; p.vy = vy; p.s = s; p.life = life; p.t = 0; p.fin = 0;
    p.fade = k === COIN ? .35 : life;
    p.rot = 0; p.vr = 0;
    live.push(p);
    return p;
  }
  function coin(x, y, vx, vy, s, life) {
    const p = add(COIN, x, y, vx, vy, s, life);
    if (!p) return null;
    p.v = Math.random() < .55 ? 0 : 1;
    p.rot = rnd(-.35, .35); p.sp = rnd(0, 6.3); p.vs = rnd(9, 17) * sign(); p.bounced = 0;
    return p;
  }
  function star(x, y, vx, vy, s, life) {
    const p = add(STAR, x, y, vx, vy, s, life);
    if (p) { p.rot = rnd(0, .8); p.vr = rnd(-3, 3); }
  }
  function later(ms, fn) {
    if (live.length + queue.length >= MAX + 40) return;
    queue.push({ at: performance.now() + ms, fn });
    queue.sort((a, b) => a.at - b.at);
  }

  /** Thrown up out of (x, y). */
  function fountain(x, y, nCoins, nStars, power, spread, small) {
    const cs = small ? [.55, .85] : [.7, 1.25], life = small ? 1.7 : 3.6;
    for (let i = 0; i < nCoins; i++) coin(x + rnd(-8, 8), y + rnd(-5, 5), rnd(-spread, spread), -rnd(.55, 1) * power, rnd(cs[0], cs[1]), life);
    for (let i = 0; i < nStars; i++) { const a = rnd(0, 6.3), v = rnd(140, 360); star(x, y, Math.cos(a) * v, Math.sin(a) * v - 60, rnd(.8, 1.4), rnd(.55, .9)); }
  }
  /** Falling from a strip [x0, x1] at height y, spread over `ms`. */
  function rain(x0, x1, y, nCoins, ms, life, fin, delay) {
    const d = delay || 0;
    for (let i = 0; i < nCoins; i++) later(d + rnd(0, ms), () => { const p = coin(rnd(x0, x1), y + rnd(-24, 10), rnd(-70, 70), rnd(40, 260), rnd(.6, 1.2), rnd(life[0], life[1])); if (p && fin) p.fin = fin; });
  }

  /** How much of a particle shows: almost nothing where it crosses the current lyric line (+ a soft edge). */
  function shade(p, r) {
    const dx = Math.max(band.l - p.x, 0, p.x - band.r), dy = Math.max(band.t - p.y, 0, p.y - band.b);
    const d = Math.max(dx, dy) - r;
    return d >= 18 ? 1 : d <= 0 ? .05 : .05 + .95 * d / 18;
  }
  function put(img, x, y, rot, sx, sy, a) {
    const c = Math.cos(rot), s = Math.sin(rot);
    g.globalAlpha = a;
    g.setTransform(c * sx * DPR, s * sx * DPR, -s * sy * DPR, c * sy * DPR, x * DPR, y * DPR);
    g.drawImage(img, -img.cw / 2, -img.ch / 2, img.cw, img.ch);
  }

  function frame(now) {
    raf = 0;
    if (!armed || !cv) return;
    if (hidden()) { stop(); return; }
    if (now - last < 14) { raf = requestAnimationFrame(frame); return; }   // ≤ ~60 draws a second on 120–160 Hz screens
    const dt = Math.min(.05, (now - last) / 1000);
    last = now;
    while (queue.length && queue[0].at <= now) queue.shift().fn();
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (box) g.clearRect(box[0], box[1], box[2] - box[0], box[3] - box[1]);
    const np = document.getElementById('np');
    const banded = band && np && np.classList.contains('on') && !np.classList.contains('nolyrics');
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let i = live.length - 1; i >= 0; i--) {
      const p = live[i];
      p.t += dt;
      if (p.k === COIN) {
        p.vy += GC * dt; p.vx -= p.vx * .25 * dt; p.vy -= p.vy * .25 * dt;
        p.sp += p.vs * dt;
        // bounces on the bottom edge twice (lower the second time), then drops out of the window
        if (p.bounced < 2 && p.vy > 0 && p.y > H - 12 * p.s) { p.y = H - 12 * p.s; p.vy *= p.bounced ? -.26 : -.42; p.vx *= .6; p.vs *= .6; p.bounced++; }
      } else {
        p.vx -= p.vx * 3 * dt; p.vy -= p.vy * 3 * dt; p.vy += 120 * dt; p.rot += p.vr * dt;
      }
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.t >= p.life || p.y > H + 80 || p.x < -120 || p.x > W + 120) { live[i] = live[live.length - 1]; live.pop(); spare.push(p); continue; }
      const r = p.k === COIN ? 20 * p.s : 16 * p.s;   // reach of what is drawn (coin + its glint)
      const rem = p.life - p.t;
      let a = p.k === STAR ? 1 : rem < p.fade ? rem / p.fade : 1;
      if (p.fin && p.t < p.fin) a *= p.t / p.fin;
      if (banded) a *= shade(p, 12 * p.s);
      if (a > .01) {
        if (p.k === COIN) {
          const c = Math.cos(p.sp), ac = Math.abs(c), off = 2.4 * p.s * Math.sin(p.sp);
          if (ac < .97) put(spr.rim, p.x + Math.cos(p.rot) * off, p.y + Math.sin(p.rot) * off, p.rot, p.s * Math.max(.1, ac), p.s, a);   // the edge shows while it turns
          if (ac > .06) put(spr.coins[p.v], p.x, p.y, p.rot, p.s * ac, p.s, a);
          if (c > .9) { const k = (c - .9) / .1; put(spr.star, p.x - 5 * p.s * ac, p.y - 6 * p.s, p.sp * .2, p.s * (.45 + .6 * k), p.s * (.45 + .6 * k), a * k); }
        } else {
          const k = p.s * Math.sin(Math.PI * Math.min(1, p.t / p.life));
          put(spr.star, p.x, p.y, p.rot, k, k, a);
        }
      }
      if (p.x - r < x0) x0 = p.x - r; if (p.x + r > x1) x1 = p.x + r;
      if (p.y - r < y0) y0 = p.y - r; if (p.y + r > y1) y1 = p.y + r;
    }
    g.globalAlpha = 1;
    box = x1 > x0 ? [Math.max(0, Math.floor(x0 * DPR) - 2), Math.max(0, Math.floor(y0 * DPR) - 2), Math.ceil(x1 * DPR) + 2, Math.ceil(y1 * DPR) + 2] : null;
    if (live.length || queue.length) raf = requestAnimationFrame(frame);
    else idle();
  }

  /* ── what throws money ── */
  function centre(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  }
  const npOpen = () => { const np = document.getElementById('np'); return !!np && np.classList.contains('on'); };

  function onPlay() {
    if (performance.now() < bootUntil || !ready()) return;
    const c = centre(document.getElementById(npOpen() ? 'np-play' : 'b-play')) || { x: W / 2, y: H - 40 };
    fountain(c.x, c.y, 90, 16, 1350, 430);
    later(300, () => fountain(c.x, c.y, 55, 8, 1200, 360));   // ka-ching: a second spurt
    later(650, () => fountain(c.x, c.y, 35, 6, 1050, 300));   // and a third
    rain(0, W, -30, 120, 1500, [3, 3.8], 0, 200);
    kick();
  }
  function onTrack() {
    if (performance.now() < bootUntil || !ready()) return;
    rain(0, W, -30, 130, 1400, [3, 3.8]);
    const c = centre(document.getElementById(npOpen() ? 'np-cover' : 'b-art'));
    if (c) fountain(c.x, c.y, 34, 8, 900, 300);
    kick();
  }
  /** While a song plays: every 7–12 s a shower out of a stretch of the top edge. */
  function shower() {
    clearTimeout(showerTimer);
    showerTimer = setTimeout(() => {
      if (!armed) return;
      if (!document.body.classList.contains('paused') && ready()) {
        const w = rnd(W * .3, W * .7), x0 = rnd(0, W - w);
        rain(x0, x0 + w, -30, (rnd(28, 46)) | 0, 1300, [2.6, 3.4]);
        kick();
      }
      shower();
    }, rnd(7000, 12000));
  }
  function onClick(e) {
    const t = e.target && e.target.closest ? e.target.closest(CLICKABLE) : null;
    if (!t || t.closest('input, textarea, select, .slider') || !ready()) return;
    const now = performance.now();
    if (now - lastClick < 90) return;
    lastClick = now;
    let x = e.clientX, y = e.clientY;
    if (!x && !y) { const c = centre(t); if (!c) return; x = c.x; y = c.y; }   // keyboard: from the middle of the control
    const card = t.classList.contains('card');
    fountain(x, y, card ? 22 : 15, card ? 5 : 3, 620, 210, true);
    kick();
  }
  /** The current line's place: it settles with its centre at 43 % of the lyrics box (nowplaying.js scrollTo). */
  function lineBand(el) {
    const lb = document.getElementById('lyrics');
    if (!lb || !el || !el.isConnected) return null;
    const b = lb.getBoundingClientRect();
    if (b.height < 60 || b.width < 60) return null;
    const rg = document.createRange(); rg.selectNodeContents(el);
    const t = rg.getBoundingClientRect();
    const l = t.width ? Math.max(b.left, t.left) : b.left + 14;
    const r = t.width ? Math.min(b.right, t.right + t.width * .04) : b.left + 120;   // still growing to scale 1 from the left
    const cy = b.top + lb.clientHeight * .43, half = (el.offsetHeight || 44) / 2;
    return { b, l, r, cy, band: { l: l - 12, r: r + 12, t: cy - half - 4, b: cy + half + 4 } };
  }
  function onLine(e) {
    const np = document.getElementById('np');
    if (!np || !np.classList.contains('on') || np.classList.contains('nolyrics') || !ready()) return;
    const el = e.detail && e.detail.el, geo = lineBand(el);
    if (!geo) return;
    band = geo.band; bandEl = el;
    const now = performance.now(), quick = now - lastLine < 1600, manual = !!(e.detail && e.detail.manual);
    lastLine = now; lineCount++;
    const big = !manual && lineCount % 4 === 1;   // the first line and every 4th after it: a jackpot line
    const b = geo.b;
    // a shower out of the top of the lyrics column; the coins fade in there and pass "behind" the current line
    rain(b.left + 20, b.right - 30, b.top + 26, big ? 70 : quick ? 14 : 30, big ? 1300 : 900, [2.2, 2.9], .25);
    // coins pop out of both ends of the line, away from it
    const n = big ? 14 : quick ? 4 : 8;
    for (const side of [-1, 1]) {
      const x = side < 0 ? geo.l + 4 : geo.r - 4;
      for (let i = 0; i < n; i++) coin(x, geo.cy + rnd(-6, 6), side * rnd(70, 260), -rnd(430, 720), rnd(.8, 1.1), 2.2);
      if (big) for (let i = 0; i < 3; i++) star(x + side * rnd(4, 26), geo.cy + rnd(-22, 22), side * rnd(40, 160), rnd(-120, 40), rnd(.9, 1.3), rnd(.6, .9));
    }
    kick();
  }
  function onVisible() { if (hidden()) { stop(); Glints.stop(); } else if (armed) Glints.start(); }
  function onResize() {
    sized = false;
    if (!cv) { W = innerWidth; H = innerHeight; }
    Glints.spotsAt = 0;
    if (cv && (raf || live.length)) size();
    if (bandEl && npOpen()) { const geo = lineBand(bandEl); band = geo ? geo.band : null; }
  }

  /* ── glints: little stars flashing all over the window ── */
  const Glints = {
    N: 26, layer: null, spots: [], spotsAt: 0, on: false,
    SEL: '.card .art, .btn, .playbtn, .page-head h1, .rail-head h2, .nav a, .sect, .np-cover, #bar, .chip, .seg, .np-title, #lyrics .ly-line.on, .hero h1',
    /** Where glints like to land: the visible gold things on the page (read at most every 4 s, when the page is idle). */
    refresh() {
      this.spotsAt = performance.now();
      const run = () => {
        const out = [];
        for (const el of document.querySelectorAll(this.SEL)) {
          const r = el.getBoundingClientRect();
          if (r.width > 8 && r.height > 8 && r.bottom > 0 && r.right > 0 && r.top < H && r.left < W) out.push([r.left, r.top, r.width, r.height]);
          if (out.length > 160) break;
        }
        this.spots = out;
      };
      if (window.requestIdleCallback) requestIdleCallback(run, { timeout: 800 }); else setTimeout(run, 50);
    },
    where() {
      if (performance.now() - this.spotsAt > 4000) this.refresh();
      const sp = this.spots;
      if (sp.length && Math.random() < .65) {
        const [l, t, w, h] = sp[(Math.random() * sp.length) | 0];
        // on an edge or a corner of it, where light catches a frame
        const e = Math.random();
        if (e < .5) return [l + (Math.random() < .5 ? 0 : w) + rnd(-3, 3), t + (Math.random() < .5 ? 0 : h) + rnd(-3, 3)];
        return [l + rnd(0, w), t + (Math.random() < .5 ? rnd(0, 6) : h - rnd(0, 6))];
      }
      return [rnd(10, W - 10), rnd(10, H - 10)];
    },
    flash(b) {
      if (!this.on) return;
      // the window hidden (also a Mac window behind others): nothing is drawn, it looks again in 2 s
      if (hidden()) { b._t = setTimeout(() => this.flash(b), 2000); return; }
      const paused = document.body.classList.contains('paused');   // paused: fewer at a time (longer gaps)
      const [x, y] = this.where(), s = rnd(.7, 1.8), i = b.firstChild;
      b.style.translate = `${x.toFixed(1)}px ${y.toFixed(1)}px`;
      const d = rnd(700, 1300), turn = rnd(30, 90) * sign();
      const a = i.animate([
        { transform: `scale(.1) rotate(0deg)`, opacity: 0 },
        { transform: `scale(${s}) rotate(${turn * .5}deg)`, opacity: 1, offset: .42 },
        { transform: `scale(${s * .35}) rotate(${turn}deg)`, opacity: 0 },
      ], { duration: d, delay: paused ? rnd(1500, 6000) : rnd(0, 2200), easing: 'ease-in-out', fill: 'both' });
      a.onfinish = () => this.flash(b);
      b._a = a;
    },
    start() {
      if (this.on || !armed || hidden()) return;
      this.on = true;
      if (!this.layer) {
        this.layer = document.createElement('div');
        this.layer.id = 'gold-glints'; this.layer.setAttribute('aria-hidden', 'true');
        for (let k = 0; k < this.N; k++) { const b = document.createElement('b'); b.append(document.createElement('i')); this.layer.append(b); }
        document.body.append(this.layer);
      }
      if (!W) { W = innerWidth; H = innerHeight; }
      this.refresh();
      for (const b of this.layer.children) this.flash(b);
    },
    stop() {
      this.on = false;
      if (!this.layer) return;
      for (const b of this.layer.children) { clearTimeout(b._t); if (b._a) { b._a.onfinish = null; b._a.cancel(); } }
    },
    remove() { this.stop(); if (this.layer) this.layer.remove(); this.layer = null; this.spots = []; },
  };

  /* ── on / off with the theme and the lightweight setting ── */
  function arm(welcome) {
    armed = true;
    document.addEventListener('click', onClick, { capture: true, passive: true });
    window.addEventListener('miku-lyric-line', onLine);
    window.addEventListener('resize', onResize, { passive: true });
    document.addEventListener('visibilitychange', onVisible);
    wasPaused = document.body.classList.contains('paused');
    bodyObs = new MutationObserver(() => {
      const p = document.body.classList.contains('paused');
      if (p === wasPaused) return;
      const started = wasPaused && !p;
      wasPaused = p;
      if (started) onPlay();
    });
    bodyObs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    const title = document.getElementById('b-title');
    lastTitle = title ? title.textContent : null;
    if (title) {
      titleObs = new MutationObserver(() => {
        const s = title.textContent, had = lastTitle;
        if (s === had) return;
        lastTitle = s;
        if (had && s) onTrack();
      });
      titleObs.observe(title, { childList: true, characterData: true, subtree: true });
    }
    // switched to 暴發戶黃金 just now: it makes an entrance
    if (welcome) welcomeTimer = setTimeout(() => { if (ready()) { rain(0, W, -30, 150, 1300, [3, 3.6]); kick(); } }, 450);
    shower();
    Glints.start();
  }
  function disarm() {
    armed = false;
    document.removeEventListener('click', onClick, { capture: true });
    window.removeEventListener('miku-lyric-line', onLine);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisible);
    if (bodyObs) bodyObs.disconnect();
    if (titleObs) titleObs.disconnect();
    bodyObs = titleObs = null;
    clearTimeout(welcomeTimer); clearTimeout(showerTimer);
    Glints.stop();
    stop();
    clearTimeout(freeTimer);
    if (cv) cv.remove();
    Glints.remove();
    cv = g = spr = box = band = bandEl = null;
    SS = 0; sized = false; lineCount = 0;
  }
  let lastTheme = root.dataset.theme;
  function sync() {
    const ok = allowed(), theme = root.dataset.theme, changed = theme !== lastTheme;
    lastTheme = theme;
    if (ok && !armed) { if (document.body) arm(changed && performance.now() > bootUntil); }
    else if (!ok && armed) disarm();
  }
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  window.addEventListener('miku-effects-change', sync);
  if (reduceMq.addEventListener) reduceMq.addEventListener('change', sync);
  if (document.body) sync(); else document.addEventListener('DOMContentLoaded', sync, { once: true });
})();

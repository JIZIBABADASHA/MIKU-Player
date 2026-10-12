'use strict';
/* The logo's secret: click the MIKU wordmark in the sidebar and a giant leek shoots across the window, root first, and flattens it; it
   stays flat until it is clicked again, when it springs back up with a flash and a shower of sparks. Nothing is saved:
   a flattened logo is whole again the next time MIKU starts. With 輕量化「頁面與操作動畫」 (or reduced motion) the logo
   only changes between flat and whole. */
const LogoEgg = {
  flat: false, busy: false,
  calm: () => matchMedia('(prefers-reduced-motion: reduce)').matches || (typeof PageEffects !== 'undefined' && PageEffects.reduced('page')),
  LEEK: '<svg viewBox="0 0 120 520" aria-hidden="true"><defs>' +
    '<linearGradient id="egg-w" x1="0" x2="1"><stop offset="0" stop-color="#e9f4e4"/><stop offset=".5" stop-color="#ffffff"/><stop offset="1" stop-color="#d5e6cf"/></linearGradient>' +
    '<linearGradient id="egg-g" x1="0" x2="1"><stop offset="0" stop-color="#1f9f6b"/><stop offset=".5" stop-color="#48d08c"/><stop offset="1" stop-color="#178a5c"/></linearGradient></defs>' +
    '<path d="M38 300 Q30 150 8 20 Q34 70 52 190 Z" fill="url(#egg-g)"/><path d="M82 300 Q92 140 112 6 Q84 80 68 190 Z" fill="url(#egg-g)"/><path d="M48 300 Q50 120 60 0 Q72 120 72 300 Z" fill="#35bd7e"/>' +
    '<rect x="38" y="280" width="44" height="210" rx="20" fill="url(#egg-w)"/><path d="M38 300 H82 V330 Q60 344 38 330 Z" fill="#8fdcae" opacity=".8"/>' +
    '<path d="M44 486 q-6 20 -12 30 M56 490 q-2 18 -4 30 M66 490 q4 18 8 30 M76 486 q8 16 14 28" stroke="#c9b48a" stroke-width="3" fill="none" stroke-linecap="round"/></svg>',
  init() {
    const brand = document.getElementById('brand');
    if (!brand || brand._egg) return;
    brand._egg = true; brand.style.cursor = 'pointer';
    brand.addEventListener('click', () => { if (!this.busy) (this.flat ? this.revive(brand) : this.crush(brand)); });
  },
  logo: brand => brand.querySelector('svg.wm'),
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
  async crush(brand) {
    const logo = this.logo(brand); if (!logo) return;
    this.flat = true; brand.classList.add('egg-flat');
    if (this.calm() || !logo.animate) return;
    this.busy = true;
    const r = logo.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2, ground = r.bottom;
    const leek = document.createElement('div');
    leek.className = 'egg-leek'; leek.innerHTML = this.LEEK;
    // the logo sits in the window's corner: the leek lies across the window (its root on the logo, its leaves towards the
    // bottom right) and comes in along its own length
    const H = Math.max(460, Math.min(innerWidth, innerHeight) * .95), W = H * 120 / 520;
    const far = Math.hypot(innerWidth, innerHeight) * .75, tilt = 'rotate(132deg)';
    leek.style.cssText = `left:${cx - W / 2}px;top:${cy - H}px;width:${W}px;height:${H}px`;
    document.body.append(leek);
    brand.classList.remove('egg-flat');   // whole until the leek lands
    const fall = leek.animate([{ transform: `translate(${far * .74}px, ${far * .67}px) ${tilt}` }, { transform: `translate(0, 0) ${tilt}` }], { duration: 430, easing: 'cubic-bezier(.55,0,1,.45)', fill: 'forwards' });
    try { await fall.finished; } catch { }
    brand.classList.add('egg-flat');
    logo.animate([{ transform: 'scale(1,1)' }, { transform: 'scale(1.5,.05)' }, { transform: 'scale(1.3,.1)' }], { duration: 170, easing: 'ease-out' });
    this.spark(cx, ground - 6, 22, ['#39c5bb', '#e5307e', '#ffffff', '#8fdcae'], 150);
    const side = document.getElementById('sidebar') || document.body;
    side.animate([0, -7, 6, -4, 3, 0].map(y => ({ transform: `translateY(${y}px)` })), { duration: 380, easing: 'ease-out' });
    // the leek recoils, grinds the logo once more, and spins away
    const leave = leek.animate([{ transform: `translate(0, 0) ${tilt}`, opacity: 1 }, { transform: `translate(44px, 40px) rotate(126deg)`, opacity: 1, offset: .2 },
      { transform: `translate(6px, 5px) rotate(136deg)`, opacity: 1, offset: .42 }, { transform: `translate(30px, 26px) rotate(140deg)`, opacity: 1, offset: .58 },
      { transform: `translate(${far * .8}px, ${far * .5}px) rotate(320deg)`, opacity: 0 }],
      { duration: 1250, easing: 'cubic-bezier(.3,.1,.5,1)', fill: 'forwards' });
    try { await leave.finished; } catch { }
    leek.remove(); this.busy = false;
  },
  async revive(brand) {
    const logo = this.logo(brand); if (!logo) return;
    this.flat = false;
    if (this.calm() || !logo.animate) { brand.classList.remove('egg-flat'); return; }
    this.busy = true;
    const r = brand.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height * .4;
    const ring = document.createElement('i');
    ring.className = 'egg-ring'; ring.style.cssText = `left:${cx}px;top:${cy}px`;
    document.body.append(ring);
    ring.animate([{ transform: 'translate(-50%,-50%) scale(.1)', opacity: .95 }, { transform: 'translate(-50%,-50%) scale(7)', opacity: 0 }], { duration: 700, easing: 'cubic-bezier(.1,.6,.2,1)' }).onfinish = () => ring.remove();
    this.spark(cx, cy, 34, ['#39c5bb', '#e5307e', '#ffffff', '#ffe66d'], 190);
    brand.classList.remove('egg-flat');
    const up = logo.animate([
      { transform: 'scale(1.3,.1) rotate(0deg)', filter: 'brightness(1) drop-shadow(0 0 0 transparent)' },
      { transform: 'scale(.7,1.55) rotate(-8deg)', filter: 'brightness(1.9) drop-shadow(0 0 14px #39c5bb)', offset: .28 },
      { transform: 'scale(1.18,.86) rotate(368deg)', filter: 'brightness(1.5) drop-shadow(0 0 18px #e5307e)', offset: .62 },
      { transform: 'scale(.96,1.05) rotate(358deg)', filter: 'brightness(1.15) drop-shadow(0 0 8px #39c5bb)', offset: .82 },
      { transform: 'scale(1,1) rotate(360deg)', filter: 'brightness(1) drop-shadow(0 0 0 transparent)' },
    ], { duration: 950, easing: 'cubic-bezier(.2,.8,.3,1)' });
    try { await up.finished; } catch { }
    this.busy = false;
  },
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => LogoEgg.init()); else LogoEgg.init();

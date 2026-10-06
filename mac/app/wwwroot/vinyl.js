'use strict';
/* ═════════════════════════════ VINYL theme: sleeve → turntable choreography ═════════════════════════════
   Open an album:  the sleeve flies to the album header (Flip), the record leaves the sleeve and flies
                   onto the turntable right of the title, the tone arm swings over, lowers, the record spins up.
   Leave it:       the arm lifts, the platter coasts to a stop, the record flies back and slides into the
                   sleeve, and only then does the page change (the sleeve then flies back into the list).
   Only active while data-theme="vinyl". Everything animates transform/opacity only.                         */
const Vinyl = {
  get on() { return document.documentElement.dataset.theme === 'vinyl'; },
  from: null,      // record position captured when a card is clicked
  deck: null,      // { el, rec, arm, hero, cover, id, spin, state }
  fly: null,       // record currently flying in (fixed, on <body>)
  leaving: 0,      // token of a pending "put the record back, then leave"

  recordEl(cls) {
    return h('div', { class: 'vrec ' + cls }, h('div', { class: 'vrec-lbl' }, h('span', null, 'MIKU'), h('i'), h('b', null, '33⅓')));
  },

  /** Where the record (the card's ::before) is right now, including its hover slide-out. */
  discRect(card) {
    if (!card) return null;
    const cr = card.getBoundingClientRect();
    const cs = getComputedStyle(card, '::before');
    if (!cs || cs.content === 'none' || !cr.width) return null;
    const w = parseFloat(cs.width) || cr.width * .94;
    let tx = 0, ty = 0;
    try { if (cs.transform && cs.transform !== 'none') { const m = new DOMMatrix(cs.transform); tx = m.e; ty = m.f; } } catch (e) { }
    return { left: cr.left + (parseFloat(cs.left) || cr.width * .03) + tx, top: cr.top + (parseFloat(cs.top) || cr.width * .03) + ty, width: w, height: w };
  },

  /** Clicking a sleeve in a list: the record slides most of the way out first, then the album opens. */
  pullOut(card, next) {
    if (!this.on || !card || card.classList.contains('artist')) return false;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    if (card.classList.contains('vpull')) return true;            // already pulling: ignore the double click
    card.classList.add('vpull');
    let done = false;
    const go = () => { if (done) return; done = true; next(); setTimeout(() => card.classList.remove('vpull'), 50); };
    setTimeout(go, 340);
    return true;
  },

  visible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.bottom > 0 && r.top < innerHeight;
  },

  /* ── album page built: add the turntable and bring the record in ── */
  mount(hero, cover, al) {
    this.dropFly();
    this.deck = null;
    if (!this.on) return;
    const rec = this.recordEl('tt-rec');
    const arm = h('div', { class: 'tt-arm' }, h('div', { class: 'tt-weight' }), h('div', { class: 'tt-rod' }), h('div', { class: 'tt-head' }));
    const el = h('div', { class: 'tt-deck', title: T('唱盤') },
      h('div', { class: 'tt-platter' }), rec, h('div', { class: 'tt-sheen' }), h('div', { class: 'tt-pivot' }), arm, h('div', { class: 'tt-led' }), h('div', { class: 'tt-knob' }));
    hero.append(el);
    const d = this.deck = { el, rec, arm, hero, cover, id: al.id, spin: null, state: 'empty' };
    const f = this.from;
    this.from = null;
    const flying = !!(f && f.id === al.id && f.rect);
    if (flying) { rec.classList.add('away'); el.classList.add('tt-empty'); }
    // wait until the router has restored the scroll position, then measure
    Promise.resolve().then(() => requestAnimationFrame(() => {
      if (this.deck !== d || !el.isConnected) return;
      if (!el.getBoundingClientRect().width) return;            // turntable hidden (narrow window)
      if (flying) this.flyIn(f.rect);
      else { d.state = 'placed'; setTimeout(() => this.dropNeedle(d), 350); }
    }));
  },

  /** The record leaves the sleeve in the list and lands on the platter. */
  flyIn(s) {
    const d = this.deck;
    d.state = 'flying';
    const t = d.rec.getBoundingClientRect();
    const fly = this.fly = this.recordEl('vrec-fly');
    Object.assign(fly.style, { left: t.left + 'px', top: t.top + 'px', width: t.width + 'px', height: t.height + 'px' });
    document.body.append(fly);
    const sc = s.width / t.width;
    const dx = (s.left + s.width / 2) - (t.left + t.width / 2), dy = (s.top + s.height / 2) - (t.top + t.height / 2);
    const lift = Math.min(140, 50 + Math.hypot(dx, dy) * .12);
    const a = fly.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(${sc}) rotate(0deg)` },
      { transform: `translate(${dx * .45}px, ${dy * .45 - lift}px) scale(${(sc + 1) / 2 * 1.06}) rotate(210deg)`, offset: .5 },
      { transform: 'translate(0px, 0px) scale(1) rotate(360deg)' },
    ], { duration: 1000, delay: 80, easing: 'cubic-bezier(.45,.05,.25,1)', fill: 'both' });
    a.onfinish = () => {
      if (this.fly === fly) this.fly = null;
      if (this.deck !== d || !d.el.isConnected) { fly.remove(); return; }
      d.rec.classList.remove('away');
      d.el.classList.remove('tt-empty');
      requestAnimationFrame(() => fly.remove());              // identical picture underneath: swap is invisible
      d.state = 'placed';
      setTimeout(() => this.dropNeedle(d), 150);
    };
  },
  dropFly() { if (this.fly) { this.fly.remove(); this.fly = null; } },

  /** Arm swings over the record, lowers onto it, then the platter spins up. */
  dropNeedle(d) {
    if (this.deck !== d || d.state !== 'placed') return;
    d.state = 'cueing';
    d.arm.classList.remove('quick');
    d.arm.classList.add('cue');
    setTimeout(() => {
      if (this.deck !== d || d.state !== 'cueing') return;
      d.arm.classList.add('down');
      setTimeout(() => { if (this.deck === d && d.state === 'cueing') this.spinUp(d); }, 280);
    }, 950);
  },
  spinUp(d) {
    d.state = 'playing';
    d.el.classList.add('on');
    // ease-in for the first turn; its end speed (2 × 360°/3.6 s) equals the steady 360°/1.8 s → no jolt
    const up = d.rec.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 3600, easing: 'cubic-bezier(.5,0,1,1)' });
    d.spin = up;
    up.onfinish = () => {
      if (this.deck !== d || d.state !== 'playing') return;
      d.spin = d.rec.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 1800, iterations: Infinity });
    };
  },
  angle(el) {
    const m = getComputedStyle(el).transform;
    if (!m || m === 'none') return 0;
    const mm = new DOMMatrix(m);
    return Math.atan2(mm.b, mm.a) * 180 / Math.PI;
  },

  /* ── leaving the album page: called by the router before it swaps the view ── */
  beforeLeave(next) {
    this.dropFly();
    if (this.leaving) { this.leaving = 0; return false; }           // navigating again mid-way: just go
    const d = this.deck;
    if (!this.on || !d || !d.el.isConnected || !['placed', 'cueing', 'playing'].includes(d.state) || !this.visible(d.el) || !this.visible(d.cover)) return false;
    const token = this.leaving = performance.now();
    this.putBack(d, () => {
      if (this.leaving !== token) return;
      this.leaving = 0;
      this.deck = null;
      next();
    });
    return true;
  },

  putBack(d, done) {
    d.state = 'returning';
    // 1. lift the arm, swing it home; the platter coasts to a stop
    const ang = this.angle(d.rec);
    if (d.spin) { d.spin.cancel(); d.spin = null; }
    d.el.classList.remove('on');
    d.rec.animate([{ transform: `rotate(${ang}deg)` }, { transform: `rotate(${ang + 90}deg)` }], { duration: 650, easing: 'cubic-bezier(.2,.6,.35,1)', fill: 'forwards' });
    d.arm.classList.remove('down');
    setTimeout(() => { d.arm.classList.add('quick'); d.arm.classList.remove('cue'); }, 140);

    // 2. record flies to just right of the sleeve, 3. slides in behind it
    setTimeout(() => {
      if (!d.el.isConnected) return done();
      const hero = d.hero, cover = d.cover;
      const hr = hero.getBoundingClientRect(), rr = d.rec.getBoundingClientRect(), cr = cover.getBoundingClientRect();
      const size = cr.width * .94;
      const fly = this.recordEl('vrec-ret');
      Object.assign(fly.style, { left: (cr.left - hr.left + (cr.width - size) / 2) + 'px', top: (cr.top - hr.top + (cr.height - size) / 2) + 'px', width: size + 'px', height: size + 'px' });
      cover.style.zIndex = 3;                                     // sleeve above the record, record above the text
      hero.insertBefore(fly, cover);
      d.rec.style.visibility = 'hidden';
      d.el.classList.add('tt-empty');
      const sc = rr.width / size;
      const x0 = (rr.left + rr.width / 2) - (cr.left + cr.width / 2), y0 = (rr.top + rr.height / 2) - (cr.top + cr.height / 2);
      const bx = cr.width * .5 + size * .5 + 6;                  // fully beside the sleeve, touching its open edge
      const a1 = fly.animate([
        { transform: `translate(${x0}px, ${y0}px) scale(${sc}) rotate(${ang + 90}deg)` },
        { transform: `translate(${(x0 + bx) / 2}px, ${y0 / 2 - 60}px) scale(1.04) rotate(${ang + 240}deg)`, offset: .55 },
        { transform: `translate(${bx}px, 0px) scale(1) rotate(${ang + 360}deg)` },
      ], { duration: 640, easing: 'cubic-bezier(.45,.05,.25,1)', fill: 'forwards' });
      a1.onfinish = () => {
        // sliding into the sleeve: its own shadow fades away (the sleeve casts the shadow now)
        const a2 = fly.animate([
          { transform: `translate(${bx}px, 0px) rotate(${ang + 360}deg)`, boxShadow: '0 0 0 1px rgba(0,0,0,.5), 0 10px 26px rgba(22,38,30,.35)' },
          { transform: `translate(0px, 0px) rotate(${ang + 450}deg)`, boxShadow: '0 0 0 1px rgba(0,0,0,0), 0 0 0 rgba(22,38,30,0)' },
        ], { duration: 420, easing: 'cubic-bezier(.55,0,.7,.4)', fill: 'forwards' });
        a2.onfinish = () => setTimeout(done, 40);
      };
    }, 420);
  },
};

/* clicking a card: remember where its record is, so it can leave the sleeve from there */
(() => {
  const cap = Flip.capture;
  Flip.capture = function (id, art) {
    cap.call(this, id, art);
    Vinyl.from = Vinyl.on && art ? { id, rect: Vinyl.discRect(art.closest('.card')) } : null;
  };
})();

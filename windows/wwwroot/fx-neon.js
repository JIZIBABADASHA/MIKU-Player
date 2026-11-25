'use strict';
/* 霓虹賽博 (neon) only: the light trails and glitches of its 2077 layer (themes.css, sig/neon.css sections 18–25) that
 * need to know something CSS can't:
 *   - which way a highlight moves: the segmented controls' sliding stand-in (.glide-pill, core.js Glide), the sidebar's
 *     pill (.nav-pill, NavPill) and a switch's knob. When their transform transition starts (transitionrun), the element
 *     gets data-nx = r / l / u / d and its trail pseudo-element plays once (Web Animations, opacity / transform only).
 *   - the lyric line that was current a moment ago: .nx-was for 1.7 s (its magenta afterglow), from 'miku-lyric-line'.
 *   - a change of track: .nx-glitch on #np and #bar for 0.6 s (a short split / jolt), seen on the bar's title.
 *   - the pointer over the now-playing page: a thin light trail of short segments that fade in 0.45 s.
 * Nothing here runs per frame on its own: everything answers an event, and the pointer trail draws at most one segment
 * a frame while the pointer moves. All of it is off unless the theme is neon, and off with 輕量化 › 關閉霓虹雨與光軌 (neon-rain; the
 * control trails also with page motion off) or the system's reduced motion. Switching theme or turning those on stops it and
 * removes what it added. */
(function () {
  const root = document.documentElement;
  const mqReduce = matchMedia('(prefers-reduced-motion: reduce)');
  const reduced = kind => (typeof PageEffects !== 'undefined' && PageEffects.reduced(kind));
  let on = false, ctlOn = false;

  /* ── which way a highlight moves ── */
  const num = (s, re) => { const m = s && s.match(re); return m ? parseFloat(m[1]) : 0; };
  const fromMatrix = (el, axis) => {
    const t = getComputedStyle(el).transform;
    if (!t || t === 'none') return 0;
    const v = t.match(/matrix(3d)?\(([^)]+)\)/);
    if (!v) return 0;
    const p = v[2].split(',').map(Number);
    return v[1] ? (axis === 'x' ? p[12] : p[13]) : (axis === 'x' ? p[4] : p[5]);
  };
  const play = (el, pseudo, frames, ms) => {
    try {
      if (el._nxA) el._nxA.cancel();
      el._nxA = el.animate(frames, { duration: ms, easing: 'cubic-bezier(.25,.7,.25,1)', pseudoElement: pseudo });
    } catch (e) { /* an engine without pseudo-element animations: no trail */ }
  };
  const fadeX = [
    { opacity: 0, transform: 'scaleX(.35)' },
    { opacity: 1, transform: 'scaleX(1)', offset: .22 },
    { opacity: 0, transform: 'scaleX(.25)' },
  ];
  const fadeY = [
    { opacity: 0, transform: 'scaleY(.35)' },
    { opacity: 1, transform: 'scaleY(1)', offset: .2 },
    { opacity: 0, transform: 'scaleY(.2)' },
  ];
  const fadeSw = [
    { opacity: 1, transform: 'skewX(-18deg) scaleX(1)' },
    { opacity: 0, transform: 'skewX(-18deg) scaleX(.2)' },
  ];
  function onRun(e) {
    if (!ctlOn || e.propertyName !== 'transform') return;
    const el = e.target;
    if (!el.classList) return;
    if (el.classList.contains('glide-pill') && !e.pseudoElement) {
      const dx = num(el.style.transform, /translate\(\s*(-?[\d.]+)px/) - fromMatrix(el, 'x');
      if (Math.abs(dx) < 4) return;
      el.dataset.nx = dx > 0 ? 'r' : 'l';
      play(el, '::after', fadeX, 440);
    } else if (el.classList.contains('nav-pill') && !e.pseudoElement) {
      const dy = num(el.style.transform, /translateY\(\s*(-?[\d.]+)px/) - fromMatrix(el, 'y');
      if (Math.abs(dy) < 4) return;
      el.dataset.nx = dy > 0 ? 'd' : 'u';
      play(el, '::after', fadeY, 520);
    } else if (el.classList.contains('switch') && e.pseudoElement === '::after') {
      el.dataset.nx = el.classList.contains('on') ? 'r' : 'l';
      play(el, '::before', fadeSw, 380);
    }
  }

  /* ── the lyric line that was current a moment ago ── */
  let lastLine = null;
  const wasTimers = new Map();
  function onLyric(e) {
    const el = e.detail && e.detail.el;
    const prev = lastLine;
    lastLine = el || null;
    if (!on || !prev || prev === el || !prev.isConnected) return;
    prev.classList.remove('nx-was');
    clearTimeout(wasTimers.get(prev));
    requestAnimationFrame(() => {
      if (!on || prev.classList.contains('on')) return;
      prev.classList.add('nx-was');
      wasTimers.set(prev, setTimeout(() => { prev.classList.remove('nx-was'); wasTimers.delete(prev); }, 1700));
    });
  }

  /* ── a change of track ── */
  let titleObs = null, lastTitle = null, glitchT = 0;
  function watchTitle() {
    const t = document.getElementById('b-title');
    if (!t || titleObs) return;
    lastTitle = t.textContent;
    titleObs = new MutationObserver(() => {
      const now = t.textContent;
      if (now === lastTitle) return;
      const had = !!lastTitle;
      lastTitle = now;
      if (!on || !had || !now) return;
      const els = [document.getElementById('np'), document.getElementById('bar')].filter(Boolean);
      els.forEach(x => x.classList.remove('nx-glitch'));
      clearTimeout(glitchT);
      requestAnimationFrame(() => {
        if (!on) return;
        els.forEach(x => x.classList.add('nx-glitch'));
        glitchT = setTimeout(() => els.forEach(x => x.classList.remove('nx-glitch')), 650);
      });
    });
    titleObs.observe(t, { childList: true, characterData: true, subtree: true });
  }

  /* ── the pointer over the now-playing page ── */
  const SEGS = 16;
  let trail = null, segs = [], segI = 0, last = null, pend = null, raf = 0;
  function trailOn() {
    const np = document.getElementById('np');
    if (!np || trail) return;
    trail = document.createElement('div');
    trail.className = 'nx-ptr'; trail.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < SEGS; i++) trail.appendChild(document.createElement('i'));
    segs = [...trail.children];
    np.appendChild(trail);
    np.addEventListener('pointermove', onMove, { passive: true });
    np.addEventListener('pointerleave', onLeave, { passive: true });
  }
  function trailOff() {
    const np = document.getElementById('np');
    if (np) { np.removeEventListener('pointermove', onMove); np.removeEventListener('pointerleave', onLeave); }
    cancelAnimationFrame(raf); raf = 0; pend = null; last = null;
    if (trail) trail.remove();
    trail = null; segs = [];
  }
  function onLeave() { last = null; pend = null; }
  function onMove(e) {
    const np = e.currentTarget;
    if (!np.classList.contains('on') || e.pointerType === 'touch') { last = null; return; }
    pend = { x: e.clientX, y: e.clientY };
    if (!raf) raf = requestAnimationFrame(draw);
  }
  function draw() {
    raf = 0;
    if (!pend || !trail) return;
    // where the trail's box is now, read every time: the page slides up when it opens (and down when it closes), so a
    // place remembered from a moment during the slide put the whole trail off the pointer from then on
    const box = trail.getBoundingClientRect();
    const p = { x: pend.x - box.left, y: pend.y - box.top };
    pend = null;
    if (!last) { last = p; return; }
    const dx = p.x - last.x, dy = p.y - last.y, len = Math.hypot(dx, dy);
    if (len < 3) return;
    const s = segs[segI]; segI = (segI + 1) % SEGS;
    s.style.transform = `translate(${last.x.toFixed(1)}px, ${last.y.toFixed(1)}px) rotate(${Math.atan2(dy, dx).toFixed(3)}rad) scaleX(${Math.min(len, 160).toFixed(1)})`;
    if (s._a) s._a.cancel();
    s._a = s.animate([{ opacity: .85 }, { opacity: 0 }], { duration: 450, easing: 'ease-out' });
    last = p;
  }

  /* ── on / off ── */
  function clean() {
    document.querySelectorAll('.nx-was').forEach(x => x.classList.remove('nx-was'));
    wasTimers.forEach(t => clearTimeout(t)); wasTimers.clear();
    clearTimeout(glitchT);
    document.querySelectorAll('.nx-glitch').forEach(x => x.classList.remove('nx-glitch'));
    document.querySelectorAll('[data-nx]').forEach(x => { if (x._nxA) x._nxA.cancel(); delete x.dataset.nx; });
  }
  function sync() {
    const neon = root.dataset.theme === 'neon';
    const calm = mqReduce.matches || reduced('neon-rain');
    const was = on;
    on = neon && !calm;
    ctlOn = on && !reduced('page');
    if (on && !was) {
      document.addEventListener('transitionrun', onRun, { passive: true });
      watchTitle();
      trailOn();
    } else if (!on && was) {
      document.removeEventListener('transitionrun', onRun);
      trailOff();
      clean();
    }
  }
  addEventListener('miku-lyric-line', onLyric);
  addEventListener('miku-effects-change', sync);
  mqReduce.addEventListener ? mqReduce.addEventListener('change', sync) : mqReduce.addListener(sync);
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sync, { once: true }); else sync();
})();

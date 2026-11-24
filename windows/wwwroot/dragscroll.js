'use strict';
/* MIKU: grab and drag with the mouse to scroll a page or a list up and down (like on a touch screen).
   A press that moves more than a few pixels, mostly up or down, becomes a drag: the list follows the pointer, a flick
   glides on and slows down by itself (Fling below), and the click that ends it opens nothing. A press that does not
   move is a click as before.
   Left alone: text fields, sliders, the scrollbar itself, anything that has its own drag (queue rows, playlist rows,
   album cards on an artist page, the sidebar's links, the EQ graph, the tag editor) and the now-playing page.
   Sideways drags belong to the home page's rails (views.js attachRailNav), which glide with Fling too. */

/* Momentum after a mouse drag, the way a touch screen or a trackpad does it: the list keeps the speed it had when the
   button was let go and slows down smoothly. The speed is measured over the last 100 ms of the drag (one pointer event
   alone is too noisy), and letting go after holding still does not glide. This is part of the drag itself, so it runs on
   the Mac too (there, wheel and trackpad scrolling are left to macOS: PageEffects.nativeScroll) and with 關閉平滑捲動,
   which is about the wheel and the jumps to the top. */
const Fling = {
  /** Remembers where the pointer was (pos: clientX or clientY) for speed(). */
  track(samples, pos, now = performance.now()) {
    samples.push([now, pos]);
    while (samples.length > 2 && now - samples[0][0] > 100) samples.shift();
  },
  /** The pointer's speed at release, in px/ms; 0 when it stood still before the button was let go. */
  speed(samples, now = performance.now()) {
    if (samples.length < 2 || now - samples[samples.length - 1][0] > 80) return 0;
    const [t0, p0] = samples[0], [t1, p1] = samples[samples.length - 1];
    return t1 - t0 < 8 ? 0 : (p1 - p0) / (t1 - t0);
  },
  /** Glides el's scrollTop (axis 'y') or scrollLeft ('x') at v px/ms and slows it down: fast, by `friction` each
   *  millisecond (0.998: a phone's normal deceleration, about half the speed gone every 350 ms); below SLOW px/ms the drag
   *  grows (up to 5×, plus a constant brake) so a slow flick stops after a short way instead of drifting on, and the end
   *  of a fast one settles instead of creeping. done() runs when it stops by itself or is stopped. Returns stop(). */
  SLOW: 1.2, SLOW_DRAG: 4, BRAKE: .0015,
  glide(el, axis, v, done, friction = .998) {
    const key = axis === 'x' ? 'scrollLeft' : 'scrollTop';
    const max = () => axis === 'x' ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
    const k = -Math.log(friction), { SLOW, SLOW_DRAG, BRAKE } = this;
    let pos = el[key], last = performance.now(), raf = 0, over = false;
    const stop = () => { if (over) return; over = true; cancelAnimationFrame(raf); done && done(); };
    v = Math.max(-8, Math.min(8, v));
    if (Math.abs(v) < .15) { stop(); return stop; }
    const dir = Math.sign(v);
    let speed = Math.abs(v);
    const run = t => {
      if (!el.isConnected) { stop(); return; }
      let dt = Math.min(40, Math.max(0, t - last)); last = t;
      // in steps of 2 ms (the drag changes with the speed): the slow part's extra drag fades out from SLOW up
      while (dt > 0 && speed > 0) {
        const h = Math.min(2, dt); dt -= h;
        const w = Math.max(0, 1 - speed / SLOW);
        const next = Math.max(0, speed - (k * (1 + SLOW_DRAG * w * w) * speed + BRAKE * w) * h);
        pos += dir * (speed + next) / 2 * h;
        speed = next;
      }
      const m = max();
      if ((dir < 0 && pos <= 0) || (dir > 0 && pos >= m)) { el[key] = Math.max(0, Math.min(m, pos)); stop(); return; }   // reached the end
      el[key] = pos;   // pos keeps the fractions the element may round away
      if (speed < .02) { stop(); return; }
      raf = requestAnimationFrame(run);
    };
    raf = requestAnimationFrame(run);
    return stop;
  },
};

(() => {
  const SKIP = 'input, textarea, select, [contenteditable], [draggable], canvas, .slider, .eq-graph, .eq-handle, .te, #nav, #bar, #np, .msel-menu, .scroll-bubble';
  let d = null, stopGlide = () => {};

  function scroller(t) {
    for (let el = t; el && el !== document.documentElement; el = el.parentElement) {
      if (el.scrollHeight <= el.clientHeight + 1) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy === 'auto' || oy === 'scroll') return el;
    }
    return null;
  }
  const halt = () => stopGlide();

  addEventListener('pointerdown', e => {
    halt();   // a press catches a gliding list, like a finger on a phone
    if (e.button !== 0 || e.pointerType !== 'mouse' || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
    const t = e.target;
    if (!(t instanceof Element) || t.closest(SKIP)) return;
    const us = getComputedStyle(t).userSelect;
    if (us === 'text' || us === 'all') return;
    const el = scroller(t);
    if (!el) return;
    // the scrollbar: the press is on the scroller itself, outside its content box
    if (t === el) { const r = el.getBoundingClientRect(); if (e.clientX - r.left >= el.clientLeft + el.clientWidth) return; }
    d = { el, x: e.clientX, y: e.clientY, top: el.scrollTop, on: false, samples: [] };
    Fling.track(d.samples, e.clientY);
    addEventListener('pointermove', move, true);
    addEventListener('pointerup', up, true);
    addEventListener('pointercancel', up, true);
  }, true);

  function move(e) {
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.on) {
      if (document.querySelector('.rail.dragging') || document.body.classList.contains('album-dragging')) { end(); return; }
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      if (Math.abs(dx) >= Math.abs(dy)) { end(); return; }   // sideways: not ours
      d.on = true;
      d.el.style.scrollBehavior = 'auto';
      document.documentElement.classList.add('drag-scrolling');
    }
    Fling.track(d.samples, e.clientY);
    d.el.scrollTop = d.top - dy;
    e.preventDefault();
  }

  function end() {
    removeEventListener('pointermove', move, true);
    removeEventListener('pointerup', up, true);
    removeEventListener('pointercancel', up, true);
    const was = d; d = null;
    return was;
  }

  function up(e) {
    const was = end();
    if (!was || !was.on) return;
    const el = was.el;
    // the click that follows this release belongs to the drag, not to what is under the pointer
    const eat = ev => { ev.stopPropagation(); ev.preventDefault(); };
    addEventListener('click', eat, { capture: true, once: true });
    setTimeout(() => { removeEventListener('click', eat, true); document.documentElement.classList.remove('drag-scrolling'); }, 0);
    if (e && e.type === 'pointerup') Fling.track(was.samples, e.clientY);
    stopGlide = Fling.glide(el, 'y', -Fling.speed(was.samples), () => { el.style.scrollBehavior = ''; stopGlide = () => {}; });
  }
  addEventListener('wheel', halt, { capture: true, passive: true });
  addEventListener('keydown', halt, { capture: true, passive: true });
})();

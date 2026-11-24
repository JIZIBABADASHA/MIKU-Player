'use strict';
/* MIKU: grab and drag with the mouse to scroll a page or a list up and down (like on a touch screen).
   A press that moves more than a few pixels, mostly up or down, becomes a drag: the list follows the pointer, a flick
   glides on for a moment, and the click that ends it opens nothing. A press that does not move is a click as before.
   Left alone: text fields, sliders, the scrollbar itself, anything that has its own drag (queue rows, playlist rows,
   album cards on an artist page, the sidebar's links, the EQ graph, the tag editor) and the now-playing page.
   Sideways drags belong to the home page's rails (views.js attachRailNav). */
(() => {
  const SKIP = 'input, textarea, select, [contenteditable], [draggable], canvas, .slider, .eq-graph, .eq-handle, .te, #nav, #bar, #np, .msel-menu, .scroll-bubble';
  let d = null, glide = 0, gliding = null;

  function scroller(t) {
    for (let el = t; el && el !== document.documentElement; el = el.parentElement) {
      if (el.scrollHeight <= el.clientHeight + 1) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy === 'auto' || oy === 'scroll') return el;
    }
    return null;
  }
  const stopGlide = () => { cancelAnimationFrame(glide); glide = 0; if (gliding) { gliding.style.scrollBehavior = ''; gliding = null; } };

  addEventListener('pointerdown', e => {
    stopGlide();
    if (e.button !== 0 || e.pointerType !== 'mouse' || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
    const t = e.target;
    if (!(t instanceof Element) || t.closest(SKIP)) return;
    const us = getComputedStyle(t).userSelect;
    if (us === 'text' || us === 'all') return;
    const el = scroller(t);
    if (!el) return;
    // the scrollbar: the press is on the scroller itself, outside its content box
    if (t === el) { const r = el.getBoundingClientRect(); if (e.clientX - r.left >= el.clientLeft + el.clientWidth) return; }
    d = { el, x: e.clientX, y: e.clientY, top: el.scrollTop, on: false, lastY: e.clientY, lastT: performance.now(), v: 0 };
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
    const now = performance.now(), dt = now - d.lastT;
    if (dt > 0) { d.v = .7 * (e.clientY - d.lastY) / dt + .3 * d.v; d.lastY = e.clientY; d.lastT = now; }
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

  function up() {
    const was = end();
    if (!was || !was.on) return;
    const el = was.el;
    // the click that follows this release belongs to the drag, not to what is under the pointer
    const eat = ev => { ev.stopPropagation(); ev.preventDefault(); };
    addEventListener('click', eat, { capture: true, once: true });
    setTimeout(() => { removeEventListener('click', eat, true); document.documentElement.classList.remove('drag-scrolling'); }, 0);
    let v = performance.now() - was.lastT > 80 ? 0 : -was.v;   // px/ms; held still before letting go: no glide
    const reduced = typeof PageEffects !== 'undefined' && PageEffects.reduced('scroll');
    if (Math.abs(v) < .25 || reduced) { el.style.scrollBehavior = ''; return; }
    v = Math.max(-6, Math.min(6, v));
    let last = performance.now();
    gliding = el;
    const run = t => {
      const dt = Math.min(32, t - last); last = t;
      const before = el.scrollTop;
      el.scrollTop = before + v * dt;
      v *= Math.pow(.996, dt);
      if (Math.abs(v) < .05 || el.scrollTop === before || !el.isConnected) { stopGlide(); return; }
      glide = requestAnimationFrame(run);
    };
    glide = requestAnimationFrame(run);
  }
  addEventListener('wheel', stopGlide, { capture: true, passive: true });
  addEventListener('keydown', stopGlide, { capture: true, passive: true });
})();

'use strict';
/* Pixel snap for the play buttons. They are centred in the transport (a grid with fractional column widths), so at
   125 % / 150 % display scaling they land between device pixels (x = 933.75) and their circle and icon are smeared
   over two pixels. This nudges each one by the remainder (CSS `translate`, separate from the hover `transform`) so it
   sits on whole device pixels. It is measured again when the window or the bar changes size and after the now-playing
   view opens or closes (its play button moves with it).
   The player bar's cover too: its hover grows it (width, height and a negative margin), and off the device pixel grid
   its four edges snap at different moments, so shrinking back ended with a late one-pixel sideways step. On whole
   device pixels, and growing by whole device pixels on each side (--art-grow), its edges move together. The cover is
   nudged with left / top (it is position: relative): a translate is applied after layout, where its clip and picture
   have already been snapped off the grid. */
(() => {
  const SEL = '.playbtn, #b-art';
  /* Read everything first, then write: one layout for the whole pass. (Taking each nudge off, measuring, and putting
     it back, element by element, laid the page out again for every one of them, and this pass is asked for often.)
     A nudge already applied is known, so an element is measured as it stands and its own nudge taken off the result:
     nothing is written at all unless a nudge has to change. */
  const applied = new WeakMap();   // element → [dx, dy] as written
  const snap = () => {
    raf = 0;
    const dpr = window.devicePixelRatio || 1;
    const art = document.getElementById('b-art');
    const todo = [];
    let grow = null;
    if (art) {
      // the hover's growth on each side: 2 % of the cover, rounded to whole device pixels (at least one)
      const size = parseFloat(getComputedStyle(art).getPropertyValue('--art')) || art.offsetWidth;
      grow = Math.max(1, Math.round(size * .02 * dpr)) / dpr + 'px';
    }
    for (const el of document.querySelectorAll(SEL)) {
      if (!el.isConnected || !el.offsetParent) continue;
      // measured at rest only: hovered or mid-transition (the cover growing, a play button's scale) its box is off the
      // grid on purpose, and a nudge measured then moved it sideways after it grew and after it shrank back (a play
      // button's glow finishing while it was scaled up). Its nudge stays as it is until it is back at rest.
      if (el.matches(':hover') || el.getAnimations().some(a => a.playState === 'running')) continue;
      const was = applied.get(el) || [0, 0];
      const r = el.getBoundingClientRect();
      const left = r.left - was[0], top = r.top - was[1];           // where it sits without its nudge
      let dx = (Math.round(left * dpr) - left * dpr) / dpr, dy = (Math.round(top * dpr) - top * dpr) / dpr;
      if (Math.abs(dx) <= .001) dx = 0;
      if (Math.abs(dy) <= .001) dy = 0;
      if (Math.abs(dx - was[0]) > .0005 || Math.abs(dy - was[1]) > .0005) todo.push([el, dx, dy]);
    }
    if (art && grow !== art.style.getPropertyValue('--art-grow')) art.style.setProperty('--art-grow', grow);
    for (const [el, dx, dy] of todo) {
      const none = !dx && !dy;
      // the cover: in layout (see above)
      if (el === art) { el.style.left = none ? '' : dx.toFixed(3) + 'px'; el.style.top = none ? '' : dy.toFixed(3) + 'px'; }
      else el.style.translate = none ? '' : `${dx.toFixed(3)}px ${dy.toFixed(3)}px`;
      applied.set(el, [none ? 0 : +dx.toFixed(3), none ? 0 : +dy.toFixed(3)]);
    }
  };
  /* One pass however many times it is asked for: at the next frame, and once more a moment after the last request
     (things are still sliding into place). Each request used to start its own timer and its own pass. */
  let raf = 0, lateT = 0, lateAt = 0;
  const asap = () => { if (!raf) raf = requestAnimationFrame(snap); };
  const late = () => { const left = lateAt - performance.now(); if (left > 4) lateT = setTimeout(late, left); else { lateT = 0; asap(); } };
  const soon = (delay = 0) => {
    if (delay <= 0) return asap();
    lateAt = Math.max(lateAt, performance.now() + delay);
    if (!lateT) lateT = setTimeout(late, delay);
  };
  addEventListener('load', () => soon(50));
  addEventListener('resize', () => soon());
  // display scaling changed (window dragged to another monitor)
  const watchDpr = () => { const m = matchMedia(`(resolution: ${devicePixelRatio}dppx)`); m.addEventListener('change', () => { soon(); watchDpr(); }, { once: true }); };
  watchDpr();
  // a transition that can move a play button or the cover: the bar, the now-playing page and its panels. Not the
  // lyrics, whose lines each finish several transitions at every line change, and not a button's own hover or glow.
  document.addEventListener('transitionend', e => {
    const t = e.target;
    if (!t.closest) return;
    if (t.matches(SEL)) return soon();                                // one of them is back at rest
    if (!t.closest('#bar, #np') || t.closest('.np-right, .np-top, .np-bg, .sig, .slider, .eq, button')) return;
    soon();
  }, true);
  // a play button's own animation ending (the bar's button pulses when playback starts): a pass that came while it ran
  // left it as it was, so it is measured again now that it is at rest
  const ended = e => { if (e.target.matches && e.target.matches(SEL)) soon(); };
  document.addEventListener('animationend', ended, true);
  document.addEventListener('animationcancel', ended, true);
  const start = () => {
    const ro = new ResizeObserver(() => soon());
    for (const el of document.querySelectorAll('#bar, .transport, .np-ctrl')) ro.observe(el);
    const np = document.getElementById('np');
    // the page opening or closing, its lyrics shown or hidden (the controls move); not its other classes
    const key = () => np.classList.contains('on') + '|' + np.classList.contains('nolyrics');
    let last = np ? key() : '';
    if (np) new MutationObserver(() => { const k = key(); if (k === last) return; last = k; soon(); soon(1000); }).observe(np, { attributes: true, attributeFilter: ['class'] });
    soon(300);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();

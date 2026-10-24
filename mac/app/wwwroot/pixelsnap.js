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
  const snap = () => {
    const dpr = window.devicePixelRatio || 1;
    const art = document.getElementById('b-art');
    if (art) {
      // the hover's growth on each side: 2 % of the cover, rounded to whole device pixels (at least one)
      const size = parseFloat(getComputedStyle(art).getPropertyValue('--art')) || art.offsetWidth;
      art.style.setProperty('--art-grow', Math.max(1, Math.round(size * .02 * dpr)) / dpr + 'px');
    }
    for (const el of document.querySelectorAll(SEL)) {
      if (!el.isConnected || !el.offsetParent) continue;
      const shift = el === art ? ['left', 'top'] : null;   // the cover: in layout (see above)
      // measured at rest only: hovered or mid-transition (the cover growing, a play button's scale) its box is off the
      // grid on purpose, and a nudge measured then moved it sideways after it grew and after it shrank back (a play
      // button's glow finishing while it was scaled up). Its nudge stays as it is until it is back at rest.
      if (el.matches(':hover') || el.getAnimations().some(a => a.playState === 'running')) continue;
      if (shift) el.style.left = el.style.top = ''; else el.style.translate = '';
      const r = el.getBoundingClientRect();
      const dx = (Math.round(r.left * dpr) - r.left * dpr) / dpr;
      const dy = (Math.round(r.top * dpr) - r.top * dpr) / dpr;
      if (Math.abs(dx) <= .001 && Math.abs(dy) <= .001) continue;
      if (shift) { el.style.left = dx.toFixed(3) + 'px'; el.style.top = dy.toFixed(3) + 'px'; }
      else el.style.translate = `${dx.toFixed(3)}px ${dy.toFixed(3)}px`;
    }
  };
  let raf = 0;
  const soon = (delay = 0) => { cancelAnimationFrame(raf); setTimeout(() => { raf = requestAnimationFrame(snap); }, delay); };
  addEventListener('load', () => soon(50));
  addEventListener('resize', () => soon());
  // display scaling changed (window dragged to another monitor)
  const watchDpr = () => { const m = matchMedia(`(resolution: ${devicePixelRatio}dppx)`); m.addEventListener('change', () => { soon(); watchDpr(); }, { once: true }); };
  watchDpr();
  document.addEventListener('transitionend', e => { if (e.target.closest && e.target.closest('#bar, #np, .np-wrap')) soon(); }, true);
  const start = () => {
    const ro = new ResizeObserver(() => soon());
    for (const el of document.querySelectorAll('#bar, .transport, .np-ctrl')) ro.observe(el);
    const np = document.getElementById('np');
    if (np) new MutationObserver(() => { soon(); soon(1000); }).observe(np, { attributes: true, attributeFilter: ['class'] });
    soon(300);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();

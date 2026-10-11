'use strict';
/* Pixel snap for the play buttons. They are centred in the transport (a grid with fractional column widths), so at
   125 % / 150 % display scaling they land between device pixels (x = 933.75) and their circle and icon are smeared
   over two pixels. This nudges each one by the remainder (CSS `translate`, separate from the hover `transform`) so it
   sits on whole device pixels. It is measured again when the window or the bar changes size and after the now-playing
   view opens or closes (its play button moves with it). */
(() => {
  const SEL = '.playbtn';
  const snap = () => {
    const dpr = window.devicePixelRatio || 1;
    for (const el of document.querySelectorAll(SEL)) {
      if (!el.isConnected || !el.offsetParent) continue;
      el.style.translate = '';
      const r = el.getBoundingClientRect();
      const dx = (Math.round(r.left * dpr) - r.left * dpr) / dpr;
      const dy = (Math.round(r.top * dpr) - r.top * dpr) / dpr;
      if (Math.abs(dx) > .001 || Math.abs(dy) > .001) el.style.translate = `${dx.toFixed(3)}px ${dy.toFixed(3)}px`;
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

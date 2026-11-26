'use strict';
/* Pixel snap for the player bar's cover, and the play / pause icon drawn on the device pixel grid.
   The play buttons are not nudged any more. They used to be moved by the remainder to whole device pixels (a CSS
   `translate`), but Chromium already puts a box and an <svg> on whole device pixels when it paints them, and the
   translate is applied after that: it moved them back off the grid. Measured at 200 %: the pause bars were 7 crisp
   device pixels wide without it and smeared over a pixel on each side with it; the same at 125 / 150 / 175 %.
   The icon itself was the other half of it. The icons are drawn on a 24-unit grid; at 20 px and 125 / 150 / 175 %
   a unit is 1.04 / 1.25 / 1.46 device pixels, so the pause bars' straight edges fell between pixels however the
   button sat, and looked soft, "blurry" (most in the themes with a dark icon on a bright button). Each play button
   now draws its own copy instead of <use>: the bars' widths, the gap and the height rounded to whole device pixels
   and centred on whole pixels, and the play triangle's flat side moved (by less than a pixel) onto one.
   The triangle sits 1 unit right of the middle (its box), not 2.3: centred on its centroid it looked pushed to the
   right, most in the square buttons (terminal, neon, poster, flat2). Drawn for the
   icon's size and the display scaling, again when either changes, and at once when core.js swaps the icon.
   The player bar's cover too: its hover grows it (width, height and a negative margin), and off the device pixel grid
   its four edges snap at different moments, so shrinking back ended with a late one-pixel sideways step. On whole
   device pixels, and growing by whole device pixels on each side (--art-grow), its edges move together. The cover is
   nudged with left / top (it is position: relative): a translate is applied after layout, where its clip and picture
   have already been snapped off the grid. */
(() => {
  const SEL = '#b-art';
  /* Read everything first, then write: one layout for the whole pass. (Taking each nudge off, measuring, and putting
     it back, element by element, laid the page out again for every one of them, and this pass is asked for often.)
     A nudge already applied is known, so an element is measured as it stands and its own nudge taken off the result:
     nothing is written at all unless a nudge has to change. */
  const applied = new WeakMap();   // element → [dx, dy] as written
  const PLAY = 'M6.2 4.9v14.2a1 1 0 0 0 1.5.86l11.6-7.1a1 1 0 0 0 0-1.72L7.7 4.04a1 1 0 0 0-1.5.86z';
  const iconName = svg => {
    const u = svg.querySelector('use');
    const n = u ? (u.getAttribute('href') || '').replace('#i-', '') : svg.dataset.icon;
    return n === 'play' || n === 'pause' ? n : '';
  };
  /* The icon's box sits on whole device pixels (Chromium snaps an <svg> when it paints it), so its shapes only have
     to land on whole pixels inside it. Reads one computed width; writes only when the size or the scaling changed. */
  const drawIcon = btn => {
    const svg = btn.querySelector(':scope > svg'), name = svg && iconName(svg);
    if (!name) return;
    const size = parseFloat(getComputedStyle(svg).width);
    if (!size) return;
    const dpr = window.devicePixelRatio || 1, key = `${name}|${size}|${dpr}`;
    if (svg.dataset.k === key) return;
    const k = size * dpr, u = k / 24, U = px => +(px / u).toFixed(3);
    let html;
    if (name === 'pause') {
      const w = Math.max(2, Math.round(4.2 * u)), g = Math.max(2, Math.round(3.6 * u)), h = Math.round(15 * u);
      const x = Math.round((k - 2 * w - g) / 2), y = Math.round((k - h) / 2), rx = Math.min(1.3, U(w) / 2);
      html = `<rect x="${U(x)}" y="${U(y)}" width="${U(w)}" height="${U(h)}" rx="${rx}"/><rect x="${U(x + w + g)}" y="${U(y)}" width="${U(w)}" height="${U(h)}" rx="${rx}"/>`;
    } else {
      const dx = Math.round(6.2 * u) - 6.2 * u;
      html = `<path${Math.abs(dx) > .01 ? ` transform="translate(${U(dx)} 0)"` : ''} d="${PLAY}"/>`;
    }
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.innerHTML = html;
    svg.dataset.icon = name;
    svg.dataset.k = key;
  };
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
    for (const b of document.querySelectorAll('.playbtn')) { if (b.style.translate) b.style.translate = ''; drawIcon(b); }
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
    // core.js swapped a play button's icon (play ↔ pause): drawn on the grid before it is painted
    const mo = new MutationObserver(recs => { for (const r of recs) drawIcon(r.target); });
    for (const b of document.querySelectorAll('.playbtn')) { mo.observe(b, { childList: true }); drawIcon(b); }
    // another theme can size the icons differently
    new MutationObserver(() => soon(300)).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const np = document.getElementById('np');
    // the page opening or closing, its lyrics shown or hidden (the controls move); not its other classes
    const key = () => np.classList.contains('on') + '|' + np.classList.contains('nolyrics');
    let last = np ? key() : '';
    if (np) new MutationObserver(() => { const k = key(); if (k === last) return; last = k; soon(); soon(1000); }).observe(np, { attributes: true, attributeFilter: ['class'] });
    soon(300);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();

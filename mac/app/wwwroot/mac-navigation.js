'use strict';
// macOS two-finger page swipes arrive as pixel wheel events, not Electron's three-finger "swipe" event.
(() => {
  const gap = 300, threshold = 140;
  let last = -Infinity, x = 0, y = 0, blocked = false, handled = false, lastNavigation = -Infinity;
  const verticalWheel = e => Math.abs(e.deltaY) >= 12 && Math.abs(e.deltaY) > Math.abs(e.deltaX) * 1.5;

  function reset() { last = -Infinity; x = y = 0; blocked = handled = false; }
  function ownsHorizontalScroll(target) {
    if (!(target instanceof Element)) return false;
    if (target.isContentEditable || target.closest('.rail, .slider, .eq-graph, input, textarea, select')) return true;
    for (let el = target; el; el = el.parentElement) {
      if (el.scrollWidth <= el.clientWidth + 2) continue;
      if (/^(auto|scroll|overlay)$/.test(getComputedStyle(el).overflowX)) return true;
    }
    return false;
  }
  function navigate(offset) {
    lastNavigation = performance.now();
    // Use the same history as the toolbar: back also closes the current overlay first.
    history.go(offset);
  }
  // Mark a consumed swipe before the cover animation's capture listener sees its trailing events.
  window.addEventListener('wheel', e => {
    if (handled && !blocked && e.timeStamp - last <= gap && !verticalWheel(e) &&
        e.deltaMode === WheelEvent.DOM_DELTA_PIXEL && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) e.mikuPageSwipe = true;
  }, { capture: true, passive: true });
  window.addEventListener('wheel', e => {
    if (!e.deltaX && !e.deltaY) return;
    // Use input time so a busy renderer cannot split one queued swipe into several gestures.
    const now = e.timeStamp;
    if (now - last > gap) {
      x = y = 0; handled = false;
      blocked = ownsHorizontalScroll(e.composedPath()[0]);
    }
    last = now;
    // Preserve pinch zoom, modified wheel controls and ordinary mouse-wheel scrolling.
    if (e.defaultPrevented || e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) blocked = true;
    if (blocked) return;
    if (handled) {
      if (verticalWheel(e)) { blocked = true; return; }
      e.preventDefault(); return;
    }
    x += e.deltaX; y += Math.abs(e.deltaY);
    // Once a gesture is vertical, its sideways drift must not become a page swipe.
    if (y > 12 && y > Math.abs(x) * 1.5) { blocked = true; return; }
    if (Math.abs(x) < threshold || Math.abs(x) < y * 1.8) return;
    handled = true;
    e.preventDefault();
    // With macOS natural scrolling, fingers moving right produce negative deltaX (back).
    navigate(x < 0 ? -1 : 1);
  }, { passive: false });
  window.addEventListener('blur', reset);
  document.addEventListener('visibilitychange', reset);
  window.mikuHost?.onMessage(msg => {
    if (msg.ev !== 'navigate' || ![-1, 1].includes(msg.d?.offset)) return;
    // Some trackpad settings can deliver both forms of the same gesture.
    if (performance.now() - lastNavigation < 700) return;
    navigate(msg.d.offset);
    last = performance.now(); handled = true; blocked = false;
  });
})();

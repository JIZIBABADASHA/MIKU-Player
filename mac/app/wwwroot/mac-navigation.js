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
  // The full-screen now-playing page (#np.on): a two-finger swipe up raises the player bar over it; down puts a raised
  // bar away again, or else closes the page. Left / right anywhere on the page (the cover too) goes to the cover's own
  // swipe, MoodWave's 👍 / 👎 while a radio plays; with nothing to vote it does nothing here (closing is the swipe down).
  // Over the lyrics (.np-right) the vertical swipe stays the lyrics' scroll. One action per swipe: its momentum tail is
  // swallowed, even once the page has closed, so the page under it does not scroll; a new swipe made while that tail is
  // still coming in shows as the deltas jumping up again, and counts on its own.
  const np = { last: -Infinity, x: 0, y: 0, mode: null, acted: -Infinity, peak: 0, low: 0, dx: 0, dy: 0 };
  const NP_Y = 50, NP_X = 50, NP_LEAN = 1.2, NP_REST = 300, NP_SWIPE = 130;   // the cover's own swipe needs 120 at once
  const npOpen = () => !!document.getElementById('np')?.classList.contains('on');
  const scrollsY = target => {
    for (let el = target; el instanceof Element && el.id !== 'np'; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 2 && /^(auto|scroll|overlay)$/.test(getComputedStyle(el).overflowY)) return true;
    }
    return false;
  };
  function toCover(dx) {
    const cover = document.getElementById('np-cover');
    if (!cover) return false;
    const f = new WheelEvent('wheel', { deltaX: dx, deltaY: 0, deltaMode: WheelEvent.DOM_DELTA_PIXEL, bubbles: true, cancelable: true });
    f.mikuForwarded = true;
    return !cover.dispatchEvent(f);   // the cover's handler took it (preventDefault)
  }
  /** Whether the now-playing page took this wheel event. */
  function npWheel(e) {
    // the tail only falls off: a swipe that rises again after the deltas have died well down is a new one (the swipe
    // that acted may still be speeding up when it acts, so a rise alone is not enough)
    const mag = Math.hypot(e.deltaX, e.deltaY), taken = np.mode === 'done' || np.mode === 'voted';
    if (taken) { if (mag >= np.peak) np.peak = np.low = mag; else np.low = Math.min(np.low, mag); }
    // a swipe the other way (the bar raised, then straight back down) is a new one at once
    const back = taken && ((np.dy && Math.sign(e.deltaY) === -np.dy && Math.abs(e.deltaY) >= 2) ||
                           (np.dx && Math.sign(e.deltaX) === -np.dx && Math.abs(e.deltaX) >= 2));
    if (e.timeStamp - np.last > gap || back || (taken && e.timeStamp - np.acted > NP_REST && np.low < np.peak * 0.35 && mag > np.low * 2 + 6)) {
      np.x = np.y = 0; np.mode = null;
    }
    np.last = e.timeStamp;
    if (taken && np.mode) { e.preventDefault(); return true; }
    if (np.mode === 'pass') return false;
    if (!npOpen() || e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) {
      np.mode = 'pass'; return false;
    }
    if (np.mode === 'side') { e.preventDefault(); return true; }
    np.x += e.deltaX; np.y += e.deltaY;
    const ax = Math.abs(np.x), ay = Math.abs(np.y);
    if (ax < 8 && ay < 8) return false;
    const target = e.composedPath()[0];
    if (ax > ay * NP_LEAN) {
      // sideways: once it has gone far enough, the cover gets one whole swipe of its own; the rest of this one stays
      // away from it, so the cover's one-swipe-until-the-wheel-rests is over by the next
      e.preventDefault();
      if (ax < NP_X) return true;
      if (toCover(Math.sign(np.x) * NP_SWIPE)) { np.mode = 'voted'; np.acted = e.timeStamp; np.peak = np.low = 0; np.dx = Math.sign(np.x); np.dy = 0; }
      else np.mode = 'side';
      return true;
    }
    if (ay <= ax * NP_LEAN) return false;
    if ((target instanceof Element && target.closest('.np-right, .ly-pick')) || scrollsY(target)) { np.mode = 'pass'; return false; }
    e.preventDefault();
    if (ay < NP_Y) return true;
    np.mode = 'done'; np.acted = e.timeStamp; np.peak = np.low = 0; np.dy = Math.sign(np.y); np.dx = 0;
    // With macOS natural scrolling, fingers moving up produce positive deltaY.
    if (np.y > 0) { if (!window.BarPeek?.on) document.getElementById('bar-peek')?.click(); }
    else if (window.BarPeek?.on) BarPeek.hide();
    else NowPlaying.hide();
    return true;
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
    if (!e.deltaX && !e.deltaY || e.mikuForwarded) return;
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
  // Ahead of the page's own handlers (the lyrics take every wheel event over them), and kept from them once taken.
  window.addEventListener('wheel', e => {
    if ((e.deltaX || e.deltaY) && !e.mikuForwarded && npWheel(e)) { e.stopPropagation(); last = -Infinity; }
  }, { capture: true, passive: false });
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

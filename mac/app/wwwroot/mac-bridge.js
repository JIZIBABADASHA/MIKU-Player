'use strict';
/* macOS build: provides the same window.chrome.webview bridge the Windows (WebView2) build talks to. */
(() => {
  const host = window.mikuHost;
  if (!host) return;
  const handlers = [];
  host.onMessage(msg => { for (const f of handlers) f({ data: msg }); });
  window.chrome = window.chrome || {};
  window.chrome.webview = {
    postMessage: s => host.send(typeof s === 'string' ? s : JSON.stringify(s)),
    addEventListener: (type, f) => { if (type === 'message') handlers.push(f); },
    removeEventListener: () => { },
  };
  document.documentElement.classList.add('mac');
  // Only freeze repeating visual effects: one-shot reveals, dialogs and loading feedback stay intact.
  const frozen = new Set();
  let windowVisible = true;
  const decorations = '.sig, .sigpop, .np-bg, #theme-bg, .ly-dots, .np-mini .art, .np-cover, .eq';
  function syncAnimations() {
    const hidden = document.hidden || !windowVisible, paused = document.body?.classList.contains('paused');
    const animations = new Set(document.getAnimations());
    for (const animation of frozen) if (!animations.has(animation)) frozen.delete(animation);
    for (const animation of animations) {
      if (animation.effect?.getTiming().iterations !== Infinity) continue;
      const el = animation.effect.target;
      if (!(el instanceof Element)) continue;
      const np = el.closest('#np');
      const idle = hidden || (paused && el.closest(decorations)) || (np && !np.classList.contains('on'));
      if (idle && animation.playState === 'running') { animation.pause(); frozen.add(animation); }
      else if (!idle && frozen.delete(animation)) animation.play();
    }
  }
  function syncVisibility() {
    const visible = !document.hidden && windowVisible;
    host.send(JSON.stringify({ m: 'ui.visibility', a: { visible } }));
    syncAnimations();
    if (typeof App !== 'undefined') { App.uiVisible = visible; App.frame(); }
  }
  host.onMessage(msg => {
    if (msg.ev !== 'windowVisibility') return;
    windowVisible = msg.d.visible;
    syncVisibility();
  });
  document.addEventListener('visibilitychange', syncVisibility);
  document.addEventListener('animationstart', syncAnimations);
  document.addEventListener('DOMContentLoaded', () => {
    const observer = new MutationObserver(() => { syncAnimations(); if (typeof App !== 'undefined') App.frame(); });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    const np = document.getElementById('np');
    if (np) observer.observe(np, { attributes: true, attributeFilter: ['class'] });
    syncVisibility();
  }, { once: true });
  // mouse back / forward buttons
  window.addEventListener('mouseup', e => {
    if (e.button === 3) { e.preventDefault(); history.back(); }
    else if (e.button === 4) { e.preventDefault(); history.forward(); }
  });
})();

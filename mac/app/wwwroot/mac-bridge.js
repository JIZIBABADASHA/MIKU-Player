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
  // Repeating decorations freeze while paused or hidden (IdleFx, effects.js); the window's visibility comes from here.
  let windowVisible = true;
  function syncVisibility() {
    const visible = !document.hidden && windowVisible;
    host.send(JSON.stringify({ m: 'ui.visibility', a: { visible } }));
    if (typeof IdleFx !== 'undefined') IdleFx.setWindowVisible(windowVisible);
    if (typeof App !== 'undefined') { App.uiVisible = visible; App.frame(); }
  }
  host.onMessage(msg => {
    if (msg.ev !== 'windowVisibility') return;
    windowVisible = msg.d.visible;
    syncVisibility();
  });
  document.addEventListener('visibilitychange', syncVisibility);
  document.addEventListener('DOMContentLoaded', () => {
    // the progress loop runs only while playing: (re)start it when the play / pause class changes
    const observer = new MutationObserver(() => { if (typeof App !== 'undefined') App.frame(); });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    syncVisibility();
  }, { once: true });
  // mouse back / forward buttons
  window.addEventListener('mouseup', e => {
    if (e.button === 3) { e.preventDefault(); history.back(); }
    else if (e.button === 4) { e.preventDefault(); history.forward(); }
  });
})();

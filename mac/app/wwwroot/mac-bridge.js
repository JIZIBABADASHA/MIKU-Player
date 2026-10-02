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
  // mouse back / forward buttons
  window.addEventListener('mouseup', e => {
    if (e.button === 3) { e.preventDefault(); history.back(); }
    else if (e.button === 4) { e.preventDefault(); history.forward(); }
  });
})();

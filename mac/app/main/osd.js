'use strict';
// The volume indicator for the held device (device-volume.js): macOS's own shows the system output's volume, not this
// device's. A small window that never takes the focus or a click, gone again by itself.
const { BrowserWindow, screen } = require('electron');
let win = null, ready = null, hideTimer = null, endTimer = null;
const W = 280, H = 64;
const HTML = `<!doctype html><meta charset=utf-8><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
html,body{margin:0;background:transparent;overflow:hidden;font:600 12px -apple-system,"PingFang TC",sans-serif;color:#fff;user-select:none;cursor:default}
#b{position:absolute;inset:6px;border-radius:16px;background:rgba(28,30,34,.92);border:1px solid rgba(255,255,255,.14);padding:9px 14px;box-sizing:border-box}
#r{display:flex;justify-content:space-between;gap:10px}#n{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#v{flex:none;font-variant-numeric:tabular-nums;opacity:.85}#t{height:5px;border-radius:3px;background:rgba(255,255,255,.2);margin-top:8px;overflow:hidden}
#f{height:100%;background:#39c5bb;border-radius:3px}</style><div id=b><div id=r><span id=n></span><span id=v></span></div><div id=t><div id=f></div></div></div>`;

function show(name, scalar, text) {
  clearTimeout(hideTimer); clearTimeout(endTimer);
  if (!win || win.isDestroyed()) {
    win = new BrowserWindow({ width: W, height: H, show: false, frame: false, transparent: true, hasShadow: false, resizable: false, movable: false,
      focusable: false, skipTaskbar: true, fullscreenable: false, minimizable: false, maximizable: false, type: 'panel',
      webPreferences: { sandbox: true, contextIsolation: true, spellcheck: false } });
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    // skipTransformProcessType: else MIKU leaves the Dock for a moment
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    ready = win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML)).catch(() => { });
  }
  const w = win;
  ready.then(() => {
    if (w.isDestroyed()) return;
    const a = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    w.setPosition(Math.round(a.x + a.width - W - 10), Math.round(a.y + 10));
    w.webContents.executeJavaScript(`document.getElementById('n').textContent=${JSON.stringify(String(name))};document.getElementById('v').textContent=${JSON.stringify(text)};document.getElementById('f').style.width='${(Math.max(0, Math.min(1, scalar)) * 100).toFixed(1)}%'`).catch(() => { });
    if (!w.isVisible()) w.showInactive();
  });
  hideTimer = setTimeout(() => { if (!w.isDestroyed()) w.hide(); }, 1600);
  endTimer = setTimeout(destroy, 30000);
}
function destroy() { clearTimeout(hideTimer); clearTimeout(endTimer); if (win && !win.isDestroyed()) win.destroy(); win = null; }
module.exports = { show, destroy };

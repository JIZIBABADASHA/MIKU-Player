'use strict';
// "Switch to shared mode?" (volume-attempt.js): a small card at the top right, above other programs because the listener
// is usually in one (or in the Sound menu). It never takes the focus and goes away by itself.
const { BrowserWindow, screen } = require('electron');
const W = 340, H = 132;
let win = null, timer = null;
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const html = t => `<!doctype html><meta charset=utf-8><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
html,body{margin:0;background:transparent;overflow:hidden;font:13px -apple-system,"PingFang TC",sans-serif;color:#fff;user-select:none;cursor:default}
#b{position:absolute;inset:6px;border-radius:16px;background:rgba(28,30,34,.96);border:1px solid rgba(255,255,255,.14);padding:13px 15px;box-sizing:border-box;display:flex;flex-direction:column}
p{margin:4px 0 0;font-size:12px;line-height:1.4;color:rgba(255,255,255,.75);flex:1}div.a{display:flex;gap:8px;justify-content:flex-end}
a{color:#fff;text-decoration:none;font-weight:600;font-size:12px;padding:6px 13px;border-radius:9px;background:rgba(255,255,255,.14);-webkit-user-drag:none}a.y{background:#39c5bb;color:#062624}a:hover{filter:brightness(1.12)}
</style><div id=b><b>${esc(t.title)}</b><p>${esc(t.text)}</p><div class=a><a href="miku-prompt:no">${esc(t.no)}</a><a class=y href="miku-prompt:yes">${esc(t.yes)}</a></div></div>`;

/** Calls answer(true | false) once; null when nobody answered. */
function ask(text, answer) {
  close();
  const w = win = new BrowserWindow({ width: W, height: H, show: false, frame: false, transparent: true, hasShadow: false, resizable: false, movable: false,
    focusable: false, skipTaskbar: true, fullscreenable: false, minimizable: false, maximizable: false, type: 'panel', acceptFirstMouse: true,
    webPreferences: { sandbox: true, contextIsolation: true, spellcheck: false, javascript: false } });
  let done = false;
  const end = v => { if (done) return; done = true; clearTimeout(timer); if (win === w) win = null; if (!w.isDestroyed()) w.destroy(); answer(v); };
  w.on('closed', () => end(null));
  w.setAlwaysOnTop(true, 'screen-saver');
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });   // else MIKU leaves the Dock for a moment
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e, url) => { e.preventDefault(); if (url === 'miku-prompt:yes') end(true); else if (url === 'miku-prompt:no') end(false); });
  w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html(text))).then(() => {
    if (w.isDestroyed()) return;
    const a = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    w.setPosition(Math.round(a.x + a.width - W - 10), Math.round(a.y + 10));
    w.showInactive();
  }).catch(() => { });
  timer = setTimeout(() => end(null), 15000);
}
function close() { clearTimeout(timer); if (win && !win.isDestroyed()) win.close(); win = null; }
module.exports = { ask, close };

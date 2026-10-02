'use strict';
// Runs inside the YouTube Music panel: reports what's playing so MIKU can show it, like the Windows build did.
const { ipcRenderer } = require('electron');
let last = 0;
function meta() {
  last = Date.now();
  const v = document.querySelector('video');
  if (!v) return;
  const bar = document.querySelector('ytmusic-player-bar');
  const q = s => bar && bar.querySelector(s);
  const img = q('img.image') || q('img');
  ipcRenderer.send('ytm', { k: 'meta', t: v.currentTime || 0, d: isFinite(v.duration) ? v.duration : 0, p: !v.paused,
    title: ((q('.title') || {}).textContent || '').trim(), by: ((q('.byline') || {}).textContent || '').trim(), img: img ? img.src : '' });
}
window.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('play', e => { if (e.target && /VIDEO|AUDIO/.test(e.target.tagName)) { ipcRenderer.send('ytm', { k: 'play' }); setTimeout(meta, 200); } }, true);
  document.addEventListener('pause', e => { if (e.target && /VIDEO|AUDIO/.test(e.target.tagName)) { ipcRenderer.send('ytm', { k: 'pause' }); meta(); } }, true);
  setInterval(() => { if (Date.now() - last > 450) meta(); }, 500);
});

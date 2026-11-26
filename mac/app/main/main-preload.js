'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const listeners = [];
ipcRenderer.on('host', (_e, msg) => { for (const f of listeners) try { f(msg); } catch (err) { console.error(err); } });
contextBridge.exposeInMainWorld('mikuHost', {
  platform: process.platform,
  send: s => ipcRenderer.send('host', s),
  onMessage: f => { listeners.push(f); },
  // 匯入播放清單: where a dropped file is (relative entries in it are found from there)
  pathOf: f => { try { return webUtils.getPathForFile(f) || null; } catch { return null; } },
});

'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const listeners = [];
ipcRenderer.on('host', (_e, msg) => { for (const f of listeners) try { f(msg); } catch (err) { console.error(err); } });
contextBridge.exposeInMainWorld('mikuHost', {
  platform: process.platform,
  send: s => ipcRenderer.send('host', s),
  onMessage: f => { listeners.push(f); },
});

'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('engineIpc', {
  send: m => ipcRenderer.send('eng', m),
  on: f => ipcRenderer.on('eng', (_e, m) => f(m)),
});

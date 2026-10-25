'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const call = name => (...args) => ipcRenderer.invoke('builder:' + name, ...args);
contextBridge.exposeInMainWorld('builder', {
  initial: call('initial'), refresh: call('refresh'), choose: call('choose'),
  build: call('build'), cancel: call('cancel'), open: call('open'), help: call('help'), auto: call('auto'),
  onEvent: callback => ipcRenderer.on('builder:event', (_event, message) => callback(message)),
});

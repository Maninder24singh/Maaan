'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vault', {
  init: () => ipcRenderer.invoke('vault:init'),
  saveSettings: s => ipcRenderer.invoke('vault:save-settings', s),
  checkPaths: s => ipcRenderer.invoke('vault:check-paths', s),
  pick: kind => ipcRenderer.invoke('vault:pick', kind),
  refresh: () => ipcRenderer.invoke('vault:refresh'),
  open: p => ipcRenderer.invoke('vault:open', p),
  reveal: p => ipcRenderer.invoke('vault:reveal', p),
  onData: fn => {
    const h = (_e, data) => fn(data);
    ipcRenderer.on('vault:data', h);
    return () => ipcRenderer.removeListener('vault:data', h);
  },
});

'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('vault', {
  init: () => ipcRenderer.invoke('vault:init'),
  saveSettings: s => ipcRenderer.invoke('vault:save-settings', s),
  checkPaths: s => ipcRenderer.invoke('vault:check-paths', s),
  pick: kind => ipcRenderer.invoke('vault:pick', kind),
  refresh: () => ipcRenderer.invoke('vault:refresh'),
  open: p => ipcRenderer.invoke('vault:open', p),
  reveal: p => ipcRenderer.invoke('vault:reveal', p),
  // Real path of a dropped file or folder (Electron no longer exposes File.path).
  pathForFile: file => webUtils.getPathForFile(file),
  connections: () => ipcRenderer.invoke('vault:connections'),
  setFeature: (name, patch) => ipcRenderer.invoke('vault:set-feature', name, patch),
  importPaths: (list, targetId) => ipcRenderer.invoke('vault:import', list, targetId),
  newProject: opts => ipcRenderer.invoke('vault:new-project', opts),
  launch: (tool, projectId) => ipcRenderer.invoke('vault:launch', tool, projectId),
  ask: text => ipcRenderer.invoke('vault:ask', text),
  approve: id => ipcRenderer.invoke('vault:approve', id),
  resetChat: () => ipcRenderer.invoke('vault:reset-chat'),
  copy: text => ipcRenderer.invoke('vault:copy', text),
  showExtension: () => ipcRenderer.invoke('vault:show-extension'),
  onToast: fn => {
    const h = (_e, t) => fn(t);
    ipcRenderer.on('vault:toast', h);
    return () => ipcRenderer.removeListener('vault:toast', h);
  },
  onData: fn => {
    const h = (_e, data) => fn(data);
    ipcRenderer.on('vault:data', h);
    return () => ipcRenderer.removeListener('vault:data', h);
  },
});

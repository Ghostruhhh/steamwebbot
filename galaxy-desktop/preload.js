const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('galaxy', {
  branding: () => ipcRenderer.invoke('branding'),
  hubInfo: () => ipcRenderer.invoke('hubInfo'),
  activate: (key, opts) => ipcRenderer.invoke('activate', key, opts),
  getHwid: () => ipcRenderer.invoke('getHwid'),
  openPath: (p) => ipcRenderer.invoke('openPath', p),
  readClipboardText: () => ipcRenderer.invoke('clipboardText'),
});

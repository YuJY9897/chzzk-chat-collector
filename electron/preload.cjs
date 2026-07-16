const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (callback) => ipcRenderer.on('state', (_event, state) => callback(state)),
  startAuth: () => ipcRenderer.invoke('auth:start'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  collectOn: (options) => ipcRenderer.invoke('collect:on', options),
  pause: () => ipcRenderer.invoke('collect:pause'),
  resume: () => ipcRenderer.invoke('collect:resume'),
  off: () => ipcRenderer.invoke('collect:off'),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  openPath: (dir) => ipcRenderer.invoke('shell:openPath', dir),
  revealFiles: () => ipcRenderer.invoke('shell:reveal')
});

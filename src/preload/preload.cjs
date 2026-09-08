const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cuppet', {
  health: () => ipcRenderer.invoke('cuppet:health'),
  sessions: {
    list: () => ipcRenderer.invoke('cuppet:session:list'),
    create: () => ipcRenderer.invoke('cuppet:session:create'),
    get: (sessionId) => ipcRenderer.invoke('cuppet:session:get', sessionId),
    send: (sessionId, text) => ipcRenderer.invoke('cuppet:session:send', sessionId, text),
    stop: (sessionId) => ipcRenderer.invoke('cuppet:session:stop', sessionId),
  },
  settings: {
    get: () => ipcRenderer.invoke('cuppet:settings:get'),
    save: (value) => ipcRenderer.invoke('cuppet:settings:save', value),
  },
  onEvent: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('cuppet:event', listener);
    return () => ipcRenderer.removeListener('cuppet:event', listener);
  },
});

const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('cuppet', {
  health: () => ipcRenderer.invoke('cuppet:health'),
  sessions: {
    list: (projectId) => ipcRenderer.invoke('cuppet:session:list', projectId),
    create: (projectId = null) => ipcRenderer.invoke('cuppet:session:create', projectId),
    get: (sessionId) => ipcRenderer.invoke('cuppet:session:get', sessionId),
    send: (sessionId, text) => ipcRenderer.invoke('cuppet:session:send', sessionId, text),
    stop: (sessionId) => ipcRenderer.invoke('cuppet:session:stop', sessionId),
  },
  projects: {
    list: () => ipcRenderer.invoke('cuppet:project:list'),
    get: (projectId) => ipcRenderer.invoke('cuppet:project:get', projectId),
    open: (projectId) => ipcRenderer.invoke('cuppet:project:open', projectId),
    addLocal: (value) => ipcRenderer.invoke('cuppet:project:add-local', value),
    cloneUrl: (value) => ipcRenderer.invoke('cuppet:project:clone-url', value),
    githubList: (query = '') => ipcRenderer.invoke('cuppet:project:github-list', query),
    githubClone: (value) => ipcRenderer.invoke('cuppet:project:github-clone', value),
    relocate: (projectId, path) => ipcRenderer.invoke('cuppet:project:relocate', projectId, path),
    remove: (projectId) => ipcRenderer.invoke('cuppet:project:remove', projectId),
  },
  native: { chooseFolder: (options) => ipcRenderer.invoke('cuppet:native:choose-folder', options) },
  settings: { get: () => ipcRenderer.invoke('cuppet:settings:get'), save: (value) => ipcRenderer.invoke('cuppet:settings:save', value) },
  onEvent: (callback) => { if (typeof callback !== 'function') return () => {}; const listener = (_event, payload) => callback(payload); ipcRenderer.on('cuppet:event', listener); return () => ipcRenderer.removeListener('cuppet:event', listener); },
});

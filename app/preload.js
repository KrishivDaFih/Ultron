const { contextBridge, ipcRenderer } = require('electron');
const listeners = new Map();
ipcRenderer.on('ai:event', (_e, msg) => { const fn = listeners.get(msg.id); if (fn) fn(msg); });
contextBridge.exposeInMainWorld('desk', {
  chat: (id, payload, onEvent) => { listeners.set(id, onEvent); return ipcRenderer.invoke('ai:chat', id, payload).finally(() => listeners.delete(id)); },
  abort: (id) => ipcRenderer.send('ai:abort', id),
  save: (filename, data) => ipcRenderer.invoke('dl:save', filename, typeof data === 'string' ? data : String(data)),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  openSettings: () => ipcRenderer.send('settings:open'),
  info: () => ipcRenderer.invoke('app:info'),
  closeSelf: () => ipcRenderer.send('settings:close')
});

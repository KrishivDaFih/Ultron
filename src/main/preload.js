'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const wrapped = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('ultron', {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    reset: () => ipcRenderer.invoke('settings:reset'),
    testHotkey: (accel) => ipcRenderer.invoke('settings:hotkeyTest', accel)
  },
  models: (provider) => ipcRenderer.invoke('providers:models', provider),
  version: () => ipcRenderer.invoke('app:version'),
  chat: {
    send: (payload) => ipcRenderer.invoke('chat:send', payload),
    abort: () => ipcRenderer.send('chat:abort'),
    approve: (id, approved) => ipcRenderer.send('chat:approval', { id, approved }),
    onDelta: on('chat:delta'),
    onTool: on('chat:tool'),
    onApprove: on('chat:approve'),
    onNote: on('chat:note'),
    onRound: on('chat:round')
  },
  history: {
    get: () => ipcRenderer.invoke('history:get'),
    save: (list) => ipcRenderer.invoke('history:save', list)
  },
  files: {
    pick: () => ipcRenderer.invoke('file:pick'),
    saveText: (suggested, content) => ipcRenderer.invoke('file:saveText', { suggested, content })
  },
  win: {
    minimise: () => ipcRenderer.send('win:minimise'),
    maximise: () => ipcRenderer.send('win:maximise'),
    close: () => ipcRenderer.send('win:close'),
    quit: () => ipcRenderer.send('win:quit'),
    openData: () => ipcRenderer.send('shell:openData')
  },
  ui: {
    onFocusInput: on('ui:focus-input'),
    onOpenSettings: on('ui:open-settings')
  }
});

'use strict';
// Secure bridge between the renderer and the main process. The renderer never
// touches Node directly — it only gets this small, explicit API surface.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cks', {
  // config
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),

  // layout
  getLayout: () => ipcRenderer.invoke('layout:get'),
  setPosition: (id, x, y) => ipcRenderer.invoke('layout:setPosition', { id, x, y }),
  removePeer: (id) => ipcRenderer.invoke('peer:remove', { id }),

  // engine
  start: () => ipcRenderer.invoke('engine:start'),
  stop: () => ipcRenderer.invoke('engine:stop'),
  status: () => ipcRenderer.invoke('engine:status'),
  releaseToLocal: () => ipcRenderer.invoke('release-to-local'),

  // events (main -> renderer)
  onLayout: (cb) => ipcRenderer.on('layout', (_e, d) => cb(d)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, d) => cb(d)),
  onLog: (cb) => ipcRenderer.on('log', (_e, d) => cb(d)),
});

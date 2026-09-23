const { contextBridge, ipcRenderer } = require('electron')

/**
 * The renderer's only door to the main process.
 *
 * CommonJS on purpose: sandboxed preloads must be CJS, and keeping this file out
 * of the ESM graph avoids Electron's preload-module caveats entirely.
 *
 * Every channel is a named operation — the renderer never gets `ipcRenderer`,
 * so it cannot reach a channel this list does not spell out.
 */
const subscribe = (channel, handler) => {
  const listener = (_event, payload) => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('barApi', {
  getState: () => ipcRenderer.invoke('bar:state'),
  setPinned: (pinned) => ipcRenderer.invoke('bar:set-pinned', pinned === true),
  setClickThrough: (on) => ipcRenderer.invoke('bar:set-click-through', on === true),
  refresh: () => ipcRenderer.invoke('bar:refresh'),
  hide: () => ipcRenderer.invoke('bar:hide'),
  quit: () => ipcRenderer.invoke('bar:quit'),
  openSettings: () => ipcRenderer.invoke('settings:open'),
  reportSize: (size) => ipcRenderer.send('bar:size', size),
  onSnapshot: (handler) => subscribe('metrics:snapshot', handler),
  onState: (handler) => subscribe('bar:state', handler),
})

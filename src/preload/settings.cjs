const { contextBridge, ipcRenderer } = require('electron')

/**
 * The settings window's door to the main process.
 *
 * Same shape as the bar's preload and for the same reason: the renderer never
 * gets `ipcRenderer`, so it cannot reach a channel this list does not spell out,
 * and a patch can only be a plain object the main process re-normalizes.
 */
const subscribe = (channel, handler) => {
  const listener = (_event, payload) => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('settingsApi', {
  get: () => ipcRenderer.invoke('settings:get'),
  set: (patch) => ipcRenderer.invoke('settings:set', patch),
  action: (name) => ipcRenderer.invoke('settings:action', name),
  onChanged: (handler) => subscribe('settings:changed', handler),
})

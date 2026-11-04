'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// Sandboxed preloads cannot require project-local modules. Keep this narrow IPC
// surface self-contained; the host validates every sender and payload again.
const subscriptions = new Set();
function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  const unsubscribe = () => { ipcRenderer.removeListener(channel, listener); subscriptions.delete(unsubscribe); };
  subscriptions.add(unsubscribe);
  return unsubscribe;
}
window.addEventListener('unload', () => { for (const unsubscribe of subscriptions) unsubscribe(); }, { once: true });
contextBridge.exposeInMainWorld('vdc', Object.freeze({
  connect: () => ipcRenderer.invoke('vdc:action', 'connect'),
  action: action => ipcRenderer.invoke('vdc:action', action),
  openConversation: key => ipcRenderer.invoke('vdc:open', key),
  sendMessage: request => ipcRenderer.invoke('vdc:send', request),
  pageHistory: request => ipcRenderer.invoke('vdc:history', request),
  onState: callback => subscribe('vdc:state', callback),
  onSnapshot: callback => subscribe('vdc:snapshot', callback)
}));

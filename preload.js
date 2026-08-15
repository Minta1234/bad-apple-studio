'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('portPicker', {
  onPorts:          (cb) => ipcRenderer.on('picker:ports', (_, ports) => cb(ports)),
  onPortDetection:  (cb) => ipcRenderer.on('picker:port-detected', (_, data) => cb(data)),
  confirm:          (portId) => ipcRenderer.send('picker:confirm', portId),
  cancel:           () => ipcRenderer.send('picker:cancel'),
});
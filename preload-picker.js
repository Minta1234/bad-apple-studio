'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('portPicker', {
  onPorts:          (cb) => ipcRenderer.on('picker:ports', (_, ports) => cb(ports)),
  onPortDetection:  (cb) => ipcRenderer.on('picker:port-detected', (_, data) => cb(data)),
  confirm:          (portId) => ipcRenderer.send('picker:confirm', portId),
  cancel:           () => ipcRenderer.send('picker:cancel'),
});

contextBridge.exposeInMainWorld('bluetoothPicker', {
  onDevices:          (cb) => ipcRenderer.on('picker:bluetooth-devices', (_, devices) => cb(devices)),
  onDeviceDetection:  (cb) => ipcRenderer.on('picker:bluetooth-device-detected', (_, device) => cb(device)),
  confirm:            (deviceId) => ipcRenderer.send('picker:bluetooth-confirm', deviceId),
  cancel:             () => ipcRenderer.send('picker:bluetooth-cancel'),
});

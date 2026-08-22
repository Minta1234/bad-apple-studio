'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('portPicker', {
  onPorts:          (cb) => ipcRenderer.on('picker:ports', (_, ports) => cb(ports)),
  onPortDetection:  (cb) => ipcRenderer.on('picker:port-detected', (_, data) => cb(data)),
  confirm:          (portId) => ipcRenderer.send('picker:confirm', portId),
  cancel:           () => ipcRenderer.send('picker:cancel'),
});
contextBridge.exposeInMainWorld('electronBluetooth', {
  onDevicesFound:   (cb) => ipcRenderer.on('bluetooth-devices-found', (_, devices) => cb(devices)),
  selectDevice:     (deviceId) => ipcRenderer.send('bluetooth-device-selected', deviceId),
  cancelScan:       () => ipcRenderer.send('bluetooth-scan-cancelled'),
});
const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('enable-web-bluetooth', true);
app.commandLine.appendSwitch('enable-experimental-web-platform-features', true);
app.whenReady().then(() => {
  let win = new BrowserWindow({webPreferences: {nodeIntegration: true, contextIsolation: false}});
  win.webContents.on('select-bluetooth-device', (e, d, cb) => {
    e.preventDefault();
    console.log('DEV', JSON.stringify(d));
    if (d.length > 0 && d[0].deviceName) {
        console.log('SELECTING', d[0].deviceId);
        cb(d[0].deviceId);
    }
  });
  win.loadURL('data:text/html,<script>navigator.bluetooth.requestDevice({acceptAllDevices:true, optionalServices: [\"12345678-1234-5678-1234-56789abcdef0\"]}).then(d => console.log(d)).catch(e => console.error(e));</script>');
});

const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const http = require('http');

let mainWindow;

function startBackend() {
  return new Promise((resolve, reject) => {
    try {
      console.log('Starting backend server directly within Electron main process...');
      require('./backend/server.js');
      
      // Wait for the backend to be healthy
      let retries = 0;
      const checkHealth = () => {
        http.get('http://127.0.0.1:3000/api/health', (res) => {
          if (res.statusCode === 200) {
            console.log('Backend is ready!');
            resolve();
          } else {
            retry();
          }
        }).on('error', retry);
      };

      const retry = () => {
        retries++;
        if (retries > 30) {
          reject(new Error('Backend server did not start in time.'));
        } else {
          setTimeout(checkHealth, 500);
        }
      };

      checkHealth();
    } catch (err) {
      reject(err);
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "Bad Apple Studio",
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Handle Web Serial API permissions
  mainWindow.webContents.session.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();
    if (portList && portList.length > 0) {
      callback(portList[0].portId);
    } else {
      callback('');
    }
  });

  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (permission === 'serial') {
      return true;
    }
    return true;
  });

  mainWindow.webContents.session.setDevicePermissionHandler((details) => {
    if (details.deviceType === 'serial') {
      return true;
    }
    return true;
  });

  mainWindow.loadURL('http://127.0.0.1:3000');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    await startBackend();
    createWindow();
  } catch (err) {
    dialog.showErrorBox('Startup Error', `Failed to start backend server:\n${err.message}`);
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

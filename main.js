const { app, BrowserWindow, dialog, shell } = require('electron');
const path = require('path');
const http = require('http');
const { execSync, spawn } = require('child_process');

// Enable Web Bluetooth
app.commandLine.appendSwitch('enable-web-bluetooth', true);

let mainWindow;

// ── Dependency definitions ────────────────────────────────────────────────────
const REQUIRED_DEPS = [
  {
    name: 'FFmpeg',
    check: () => { execSync('ffmpeg -version', { stdio: 'pipe' }); },
    description: 'Required to process and convert video files.',
    wingetId: 'Gyan.FFmpeg',
    installCmd: ['winget', ['install', '--id', 'Gyan.FFmpeg', '-e', '--source', 'winget']],
    manualUrl: 'https://ffmpeg.org/download.html',
  },
  {
    name: 'PlatformIO CLI',
    check: () => { execSync('pio --version', { stdio: 'pipe' }); },
    description: 'Required to compile ESP32 firmware.',
    installCmd: ['pip', ['install', 'platformio', '--break-system-packages']],
    manualUrl: 'https://docs.platformio.org/en/latest/core/installation/index.html',
  },
];

function checkDep(dep) {
  try { dep.check(); return true; } catch (_) { return false; }
}

async function installDep(dep) {
  const [cmd, args] = dep.installCmd;
  return new Promise((resolve) => {
    // Spawn a visible console window so the user can see progress
    const proc = spawn(cmd, args, {
      shell: false,
      windowsHide: false,
    });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

async function detectAndInstallDeps() {
  const missing = REQUIRED_DEPS.filter(d => !checkDep(d));
  if (missing.length === 0) return;

  for (const dep of missing) {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: `Missing: ${dep.name}`,
      message: `${dep.name} is not installed.`,
      detail: `${dep.description}\n\nWould you like Bad Apple Studio to install it automatically?\n(Requires internet connection)`,
      buttons: ['Install Automatically', 'Open Download Page', 'Skip'],
      defaultId: 0,
      cancelId: 2,
    });

    if (response === 0) {
      // Auto-install
      const progressBox = new BrowserWindow({
        width: 500, height: 120,
        resizable: false, minimizable: false,
        alwaysOnTop: true, frame: true,
        title: `Installing ${dep.name}...`,
        webPreferences: { nodeIntegration: false },
      });
      progressBox.loadURL(`data:text/html,<body style="font-family:sans-serif;padding:20px;background:#1a1a2e;color:#eee"><p>Installing <b>${dep.name}</b>... Please wait. A terminal window may appear.</p></body>`);

      const success = await installDep(dep);
      progressBox.close();

      if (success && checkDep(dep)) {
        dialog.showMessageBox({ type: 'info', title: 'Installed', message: `${dep.name} installed successfully!`, buttons: ['OK'] });
      } else {
        const { response: retryResponse } = await dialog.showMessageBox({
          type: 'error',
          title: `Installation Failed`,
          message: `Could not auto-install ${dep.name}.`,
          detail: 'Please install it manually.',
          buttons: ['Open Download Page', 'Skip'],
        });
        if (retryResponse === 0) shell.openExternal(dep.manualUrl);
      }
    } else if (response === 1) {
      shell.openExternal(dep.manualUrl);
    }
    // Skip — continue without this dep
  }
}

// ── Backend startup ───────────────────────────────────────────────────────────
function startBackend() {
  return new Promise((resolve, reject) => {
    try {
      console.log('Starting backend server directly within Electron main process...');
      require('./backend/server.js');
      
      // Wait for the backend to be healthy
      let retries = 0;
      const checkHealth = () => {
        http.get('http://localhost:4005/api/health', (res) => {
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

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Bad Apple Studio',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    autoHideMenuBar: true,
    backgroundColor: '#202124',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
  });

  // ── Cancel stuck esp-web-tools dialog with Escape ─────────────────────────
  // showModal() makes the entire page inert, so normal DOM event listeners
  // can't receive clicks or keystrokes.  `before-input-event` fires at the
  // Chromium compositor level BEFORE inertness is applied, so it always works.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'Escape' && input.type === 'keyDown') {
      mainWindow.webContents.executeJavaScript(`
        (function() {
          const ewt = document.querySelector('ewt-install-dialog');
          if (ewt) {
            // Try the component's own close method first (properly releases serial port)
            if (typeof ewt._closeDialog === 'function') {
              ewt._closeDialog();
            } else {
              // Dispatch 'closed' event so install-button.js calls port.close()
              ewt.dispatchEvent(new CustomEvent('closed', { bubbles: true, composed: true }));
              ewt.remove();
            }
            document.body.style.overflow = '';
            return true;
          }
          return false;
        })();
      `).then(removed => {
        if (removed) event.preventDefault();
      }).catch(() => {});
    }
  });

  // Show a native port picker dialog instead of auto-selecting
  mainWindow.webContents.session.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();

    if (!portList || portList.length === 0) {
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'No Ports Found',
        message: 'No serial ports were detected.',
        detail: 'Make sure the ESP32 is plugged in via USB and that its USB drivers are installed.',
        buttons: ['OK'],
      });
      callback('');
      return;
    }

    if (portList.length === 1) {
      callback(portList[0].portId);
      return;
    }

    // Multiple ports — open the custom Chrome-style picker
    let pickerWindow = new BrowserWindow({
      width: 450,
      height: 400,
      parent: mainWindow,
      modal: true,
      show: false,
      autoHideMenuBar: true,
      resizable: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload-picker.js')
      }
    });

    pickerWindow.loadFile(path.join(__dirname, 'port-picker.html'));

    pickerWindow.once('ready-to-show', () => {
      pickerWindow.show();
      pickerWindow.webContents.send('picker:ports', portList);
    });

    // Hotplug: these two events only fire between select-serial-port and
    // the callback being invoked (see Electron docs), so it's safe to
    // attach them here per-request rather than once globally.
    const onPortAdded = (_event, port) => {
      if (!pickerWindow.isDestroyed()) {
        pickerWindow.webContents.send('picker:port-detected', { port, removed: false });
      }
    };
    const onPortRemoved = (_event, port) => {
      if (!pickerWindow.isDestroyed()) {
        pickerWindow.webContents.send('picker:port-detected', { port, removed: true });
      }
    };
    mainWindow.webContents.session.on('serial-port-added', onPortAdded);
    mainWindow.webContents.session.on('serial-port-removed', onPortRemoved);

    let handled = false;
    
    const onConfirm = (event, portId) => {
      if (event.sender !== pickerWindow.webContents) return;
      handled = true;
      callback(portId);
      pickerWindow.close();
    };
    
    const onCancel = (event) => {
      if (event.sender !== pickerWindow.webContents) return;
      handled = true;
      callback('');
      pickerWindow.close();
    };

    ipcMain.once('picker:confirm', onConfirm);
    ipcMain.once('picker:cancel', onCancel);

    pickerWindow.on('closed', () => {
      ipcMain.removeListener('picker:confirm', onConfirm);
      ipcMain.removeListener('picker:cancel', onCancel);
      mainWindow.webContents.session.removeListener('serial-port-added', onPortAdded);
      mainWindow.webContents.session.removeListener('serial-port-removed', onPortRemoved);
      if (!handled) callback('');
    });
  });

  let bluetoothResolve = null;
  let activeDeviceListSnapshot = []; // tied to the current callback only

  mainWindow.webContents.on('select-bluetooth-device', (event, deviceList, callback) => {
    event.preventDefault();
    if (deviceList.length > 0) {
      console.log('[BLE] First device raw data:', JSON.stringify(deviceList[0]));
    }

    bluetoothResolve = callback;         // only the latest callback is valid
    activeDeviceListSnapshot = deviceList;
    if (!mainWindow.isDestroyed() && mainWindow.webContents) {
      mainWindow.webContents.send('bluetooth-devices-found', deviceList);
    }
  });

  ipcMain.on('bluetooth-device-selected', (event, deviceId) => {
    if (!bluetoothResolve) return; // old request or already auto-selected
    const stillValid = activeDeviceListSnapshot.some(d => d.deviceId === deviceId);
    if (!stillValid) return; // prevent ID from an old snapshot
    console.log('[BLE] Web page selected device:', deviceId);
    bluetoothResolve(deviceId);
    bluetoothResolve = null;
  });

  ipcMain.on('bluetooth-scan-cancelled', (event) => {
    if (bluetoothResolve) {
      console.log('[BLE] Web page cancelled scan');
      bluetoothResolve('');
      bluetoothResolve = null;
      activeDeviceListSnapshot = [];
    }
  });

  mainWindow.loadURL('http://localhost:4005');
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
const { ipcMain } = require('electron');

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  try {
    await startBackend();
    await detectAndInstallDeps();
    createWindow();
  } catch (err) {
    dialog.showErrorBox('Startup Error', `Failed to start backend server:\n${err.message}`);
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
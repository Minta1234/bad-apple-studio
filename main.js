const { app, BrowserWindow, dialog, shell } = require('electron');
const path = require('path');
const http = require('http');
const { execSync, spawn } = require('child_process');

// Enable Web Bluetooth
app.commandLine.appendSwitch('enable-web-bluetooth', true);

let mainWindow;

// ── PATH refresh ──────────────────────────────────────────────────────────────
// After winget installs a tool the current process.env.PATH is stale.
// This reads the live User+System PATH from the Windows registry so newly
// installed binaries are immediately visible without restarting the app.
function refreshPath() {
  try {
    const { refreshPath: rp } = require('./backend/src/lib/refreshPath');
    rp();
  } catch (_) { /* non-Windows or file not found — skip */ }
}

// ── Dependency definitions ────────────────────────────────────────────────────
const REQUIRED_DEPS = [
  {
    name: 'Python',
    check: () => { execSync('python --version', { stdio: 'pipe', windowsHide: true }); },
    description: 'Required by PlatformIO to compile ESP32 firmware.',
    installCmd: ['winget', ['install', '--id', 'Python.Python.3.12', '-e', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements']],
    manualUrl: 'https://www.python.org/downloads/',
    needsPathRefresh: true,
  },
  {
    name: 'FFmpeg',
    check: () => { execSync('ffmpeg -version', { stdio: 'pipe', windowsHide: true }); },
    description: 'Required to process and convert video files.',
    installCmd: ['winget', ['install', '--id', 'Gyan.FFmpeg', '-e', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements']],
    manualUrl: 'https://ffmpeg.org/download.html',
    needsPathRefresh: true,
  },
  {
    name: 'Git',
    check: () => { execSync('git --version', { stdio: 'pipe', windowsHide: true }); },
    description: 'Used by PlatformIO to download some board toolchains.\n(Optional but strongly recommended)',
    installCmd: ['winget', ['install', '--id', 'Git.Git', '-e', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements']],
    manualUrl: 'https://git-scm.com/download/win',
    needsPathRefresh: true,
    optional: true,  // don't block startup if user skips
  },
  {
    name: 'PlatformIO CLI',
    check: () => { execSync('pio --version', { stdio: 'pipe', windowsHide: true }); },
    description: 'Required to compile ESP32 firmware.',
    installCmd: ['pip', ['install', 'platformio', '--break-system-packages']],
    manualUrl: 'https://docs.platformio.org/en/latest/core/installation/index.html',
    needsPathRefresh: true,
  },
];

function checkDep(dep) {
  try { dep.check(); return true; } catch (_) { return false; }
}

async function installDep(dep) {
  const [cmd, args] = dep.installCmd;
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      shell: true,
      windowsHide: false,
    });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

/**
 * After PlatformIO CLI is installed, make sure the ESP32 platform
 * (toolchain, framework, etc.) is also installed so `pio run` works
 * offline for the first real compile.
 */
async function ensureESP32Toolchain() {
  try {
    // Quick check: if `pio pkg list -g -p espressif32` succeeds there's
    // at least one version installed globally.
    execSync('pio pkg list -g -p espressif32', { stdio: 'pipe', windowsHide: true });
    return; // already installed
  } catch (_) { /* not installed — continue */ }

  return new Promise((resolve) => {
    const proc = spawn('pio', ['pkg', 'install', '-g', '-p', 'espressif32'], {
      shell: true,
      windowsHide: false,
    });
    proc.on('close', () => resolve());
    proc.on('error', () => resolve());
  });
}

async function detectAndInstallDeps() {
  const missing = REQUIRED_DEPS.filter(d => !checkDep(d));
  if (missing.length === 0) {
    // Even if nothing is missing, still ensure ESP32 toolchain
    await ensureESP32Toolchain();
    return;
  }

  for (const dep of missing) {
    const buttons = ['Install Automatically', 'Open Download Page'];
    if (dep.optional) buttons.push('Skip (not required)');
    else buttons.push('Skip');

    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: `Missing: ${dep.name}`,
      message: `${dep.name} is not installed.`,
      detail: `${dep.description}\n\nWould you like Bad Apple Studio to install it automatically?\n(Requires internet connection)`,
      buttons,
      defaultId: 0,
      cancelId: 2,
    });

    if (response === 0) {
      // Auto-install
      const progressBox = new BrowserWindow({
        width: 520, height: 140,
        resizable: false, minimizable: false,
        alwaysOnTop: true, frame: true,
        title: `Installing ${dep.name}...`,
        webPreferences: { nodeIntegration: false },
      });
      progressBox.loadURL(`data:text/html,<body style="font-family:'Segoe UI',sans-serif;padding:24px;background:#1a1a2e;color:#eee"><p style="font-size:15px">Installing <b>${dep.name}</b>… Please wait.</p><p style="font-size:13px;color:#888">A terminal window may appear. Do not close it.</p></body>`);

      const success = await installDep(dep);

      // Refresh PATH so the newly installed binary is visible
      if (dep.needsPathRefresh) refreshPath();

      progressBox.close();

      if (success && checkDep(dep)) {
        await dialog.showMessageBox({
          type: 'info',
          title: 'Installed',
          message: `${dep.name} installed successfully!`,
          buttons: ['OK'],
        });
      } else {
        const { response: retryResponse } = await dialog.showMessageBox({
          type: 'error',
          title: `Installation Failed`,
          message: `Could not auto-install ${dep.name}.`,
          detail: 'Please install it manually, then restart the app.',
          buttons: ['Open Download Page', 'Skip'],
        });
        if (retryResponse === 0) shell.openExternal(dep.manualUrl);
      }
    } else if (response === 1) {
      shell.openExternal(dep.manualUrl);
    }
    // Skip — continue without this dep
  }

  // After all deps are resolved, ensure ESP32 toolchain is present
  if (checkDep(REQUIRED_DEPS.find(d => d.name === 'PlatformIO CLI'))) {
    const toolchainBox = new BrowserWindow({
      width: 520, height: 140,
      resizable: false, minimizable: false,
      alwaysOnTop: true, frame: true,
      title: 'Preparing ESP32 toolchain...',
      webPreferences: { nodeIntegration: false },
    });
    toolchainBox.loadURL(`data:text/html,<body style="font-family:'Segoe UI',sans-serif;padding:24px;background:#1a1a2e;color:#eee"><p style="font-size:15px">Downloading <b>ESP32 toolchain</b>… This may take a few minutes on first run.</p><p style="font-size:13px;color:#888">Please wait.</p></body>`);

    await ensureESP32Toolchain();
    toolchainBox.close();
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
      }).catch(() => { });
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
    // Refresh PATH first so we can detect tools that were installed in
    // a previous session but whose PATH wasn't visible to this process.
    refreshPath();

    await detectAndInstallDeps();
    await startBackend();
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
const { app, BrowserWindow, dialog, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execSync, exec, spawn } = require('child_process');

// Enable Web Bluetooth
app.commandLine.appendSwitch('enable-web-bluetooth', true);

let mainWindow;
let backendServer = null;
const startupProcesses = new Set();

// Release builds can carry FFmpeg and a self-contained PlatformIO Python
// environment in resources/tools. Put those folders first so the executable
// works on a clean Windows PC without winget, pip, or a system PATH setup.
function useBundledTools() {
  const toolRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'tools')
    : path.join(__dirname, 'tools');
  const directories = [
    path.join(toolRoot, 'ffmpeg'),
    path.join(toolRoot, 'platformio'),
    path.join(toolRoot, 'platformio', 'Scripts'),
  ];
  const existing = directories.filter(dir => require('fs').existsSync(dir));
  if (existing.length) {
    process.env.PATH = `${existing.join(path.delimiter)}${path.delimiter}${process.env.PATH || ''}`;
    // Keep downloaded platforms/toolchains beside the executable too.
    process.env.PLATFORMIO_CORE_DIR = path.join(toolRoot, 'platformio-core');
  }
}

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
    checkCmd: 'python --version',
    check: () => { execSync('python --version', { stdio: 'pipe', windowsHide: true }); },
    description: 'Required by PlatformIO to compile ESP32 firmware.',
    installCmd: ['winget', ['install', '--id', 'Python.Python.3.12', '-e', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements']],
    manualUrl: 'https://www.python.org/downloads/',
    needsPathRefresh: true,
  },
  {
    name: 'FFmpeg',
    checkCmd: 'ffmpeg -version',
    check: () => { execSync('ffmpeg -version', { stdio: 'pipe', windowsHide: true }); },
    description: 'Required to process and convert video files.',
    installCmd: ['winget', ['install', '--id', 'Gyan.FFmpeg', '-e', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements']],
    manualUrl: 'https://ffmpeg.org/download.html',
    needsPathRefresh: true,
  },
  {
    name: 'Git',
    checkCmd: 'git --version',
    check: () => { execSync('git --version', { stdio: 'pipe', windowsHide: true }); },
    description: 'Used by PlatformIO to download some board toolchains.\n(Optional but strongly recommended)',
    installCmd: ['winget', ['install', '--id', 'Git.Git', '-e', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements']],
    manualUrl: 'https://git-scm.com/download/win',
    needsPathRefresh: true,
    optional: true,  // don't block startup if user skips
  },
  {
    name: 'PlatformIO CLI',
    checkCmd: 'pio --version',
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

function checkDepAsync(dep) {
  return new Promise((resolve) => {
    exec(dep.checkCmd, { windowsHide: true, timeout: 8000 }, (err) => resolve(!err));
  });
}

function stripAnsiAndControl(str) {
  return String(str || '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function parseProgressOutput(chunk, lastPercent = -1) {
  const cleaned = stripAnsiAndControl(chunk);
  const lines = cleaned
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l && !/^[-\\|/─█▒░\s]+$/.test(l));
  let percent = lastPercent;
  let latestLine = lines.length ? lines[lines.length - 1] : '';
  for (const line of lines) {
    const m = line.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
    if (m) {
      const val = Math.round(parseFloat(m[1]));
      if (Number.isFinite(val) && val >= 0 && val <= 100) {
        percent = val;
      }
    }
  }
  return { percent, line: latestLine.slice(0, 120) };
}

function createInstallProgressWindow(title, heading, subtitle) {
  const win = new BrowserWindow({
    width: 520,
    height: 190,
    resizable: false,
    minimizable: false,
    alwaysOnTop: true,
    frame: true,
    title,
    webPreferences: { nodeIntegration: false },
  });

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:'Segoe UI',sans-serif;padding:20px 22px;margin:0;background:#1a1a2e;color:#eee;}
    .top{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:14px;}
    .pct{font-weight:700;color:#4fc3f7;font-variant-numeric:tabular-nums;}
    .track{width:100%;height:12px;background:rgba(255,255,255,0.12);border-radius:6px;overflow:hidden;}
    .bar{height:100%;width:100%;background:linear-gradient(90deg,#0288d1,#2dbbeb);border-radius:6px;transition:width .25s ease;}
    .bar.indeterminate{width:40%;animation:indet 1.3s infinite ease-in-out;}
    @keyframes indet{0%{transform:translateX(-110%);}100%{transform:translateX(260%);}}
    .sub{font-size:12px;color:#aaa;margin-top:8px;}
    .log{font-family:Consolas,monospace;font-size:11px;color:#80deea;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:16px;}
  </style></head><body>
    <div class="top"><span id="heading">${heading}</span><span id="pct" class="pct">...</span></div>
    <div class="track"><div id="bar" class="bar indeterminate"></div></div>
    <div id="sub" class="sub">${subtitle}</div>
    <div id="log" class="log">Starting...</div>
  </body></html>`;

  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.setProgressBar(2); } catch (_) {} // indeterminate taskbar pulse
  }

  let ready = false;
  let pending = null;
  const applyState = (state) => {
    if (win.isDestroyed()) return;
    const pct = typeof state.percent === 'number' ? state.percent : -1;
    const log = state.log || '';
    const sub = state.subtitle || '';
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.setProgressBar(pct >= 0 ? Math.min(1, Math.max(0.02, pct / 100)) : 2);
      } catch (_) {}
    }
    win.webContents.executeJavaScript(`(function(){
      var bar = document.getElementById('bar');
      var pctEl = document.getElementById('pct');
      var logEl = document.getElementById('log');
      var subEl = document.getElementById('sub');
      var p = ${JSON.stringify(pct)};
      if (bar) {
        if (p >= 0) { bar.classList.remove('indeterminate'); bar.style.width = Math.max(3, Math.min(100, p)) + '%'; }
        else { bar.classList.add('indeterminate'); bar.style.width = '40%'; }
      }
      if (pctEl) pctEl.textContent = p >= 0 ? (p + '%') : '...';
      if (logEl && ${JSON.stringify(Boolean(log))}) logEl.textContent = ${JSON.stringify(log)};
      if (subEl && ${JSON.stringify(Boolean(sub))}) subEl.textContent = ${JSON.stringify(sub)};
    })()`).catch(() => {});
  };

  win.webContents.once('did-finish-load', () => {
    ready = true;
    if (pending) {
      applyState(pending);
      pending = null;
    }
  });

  return {
    update(state) {
      if (win.isDestroyed()) return;
      if (!ready) { pending = state; return; }
      applyState(state);
    },
    close() {
      if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.setProgressBar(-1); } catch (_) {}
      }
      if (!win.isDestroyed()) win.close();
    },
  };
}

function runProcessWithProgress(cmd, args, onProgress) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      shell: true,
      windowsHide: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    startupProcesses.add(proc);
    let lastPercent = -1;
    const handleChunk = (buf) => {
      if (typeof onProgress !== 'function') return;
      const parsed = parseProgressOutput(buf.toString('utf8'), lastPercent);
      lastPercent = parsed.percent;
      if (parsed.line || parsed.percent >= 0) {
        onProgress({ percent: parsed.percent, log: parsed.line });
      }
    };
    if (proc.stdout) proc.stdout.on('data', handleChunk);
    if (proc.stderr) proc.stderr.on('data', handleChunk);
    proc.once('close', () => startupProcesses.delete(proc));
    proc.once('error', () => startupProcesses.delete(proc));
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

async function installDep(dep, onProgress) {
  const [cmd, args] = dep.installCmd;
  return runProcessWithProgress(cmd, args, onProgress);
}

/**
 * After PlatformIO CLI is installed, make sure the ESP32 platform
 * (toolchain, framework, etc.) is also installed so `pio run` works
 * offline for the first real compile.
 */
async function ensureESP32Toolchain(onProgress) {
  const pioCore = process.env.PLATFORMIO_CORE_DIR || path.join(os.homedir(), '.platformio');
  if (fs.existsSync(path.join(pioCore, 'platforms', 'espressif32'))) {
    return; // Fast disk check avoids booting Python/PIO on every launch
  }

  const hasPlatform = await new Promise((resolve) => {
    exec('pio pkg list -g -p espressif32', { windowsHide: true, timeout: 6000 }, (err) => resolve(!err));
  });
  if (hasPlatform) return;

  await runProcessWithProgress('pio', ['pkg', 'install', '-g', '-p', 'espressif32'], onProgress);
}

async function detectAndInstallDeps() {
  const results = await Promise.all(REQUIRED_DEPS.map(d => checkDepAsync(d)));
  const missing = REQUIRED_DEPS.filter((_, idx) => !results[idx]);
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
      // Auto-install with live progress bar window
      const progressUi = createInstallProgressWindow(
        `Installing ${dep.name}...`,
        `Installing <b>${dep.name}</b>… Please wait.`,
        'Downloading and installing automatically. Do not close the app.'
      );

      const success = await installDep(dep, (state) => progressUi.update(state));

      // Refresh PATH so the newly installed binary is visible
      if (dep.needsPathRefresh) refreshPath();

      progressUi.close();

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
    const pioCore = process.env.PLATFORMIO_CORE_DIR || path.join(os.homedir(), '.platformio');
    const needsToolchainPopup = !fs.existsSync(path.join(pioCore, 'platforms', 'espressif32'));
    const toolchainUi = needsToolchainPopup
      ? createInstallProgressWindow(
          'Preparing ESP32 toolchain...',
          'Downloading <b>ESP32 toolchain</b>…',
          'This may take a few minutes on first run. Please wait.'
        )
      : null;

    await ensureESP32Toolchain((state) => {
      if (toolchainUi) toolchainUi.update(state);
    });
    if (toolchainUi) toolchainUi.close();
  }
}

// ── Backend startup ───────────────────────────────────────────────────────────
function startBackend() {
  return new Promise((resolve, reject) => {
    try {
      console.log('Starting backend server directly within Electron main process...');
      backendServer = require('./backend/server.js').server;

      // Wait for the backend to be responsive via lightweight /api/ping
      let retries = 0;
      const checkPing = () => {
        http.get('http://localhost:4005/api/ping', (res) => {
          res.resume();
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
        if (retries > 120) {
          reject(new Error('Backend server did not start in time.'));
        } else {
          setTimeout(checkPing, 50);
        }
      };

      checkPing();
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

  // Always show the custom picker, including when exactly one device is
  // available, so the user can verify which port is being used.
  mainWindow.webContents.session.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();

    // Open the custom Chrome-style picker even when the initial list is empty;
    // hotplug events below can populate it when the user plugs the board in.
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
    useBundledTools();
    refreshPath();
    await startBackend();
    createWindow();

    // Run dependency installation checks after window appears
    setTimeout(() => {
      void detectAndInstallDeps();
    }, 300);
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

// Stop the embedded backend and terminate FFmpeg/PlatformIO descendants when
// the Electron window closes. On Windows taskkill /T is required because PIO
// and FFmpeg can otherwise outlive their Node parent process.
app.on('before-quit', () => {
  for (const proc of startupProcesses) {
    try {
      if (process.platform === 'win32' && proc.pid) {
        const killer = spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { windowsHide: true });
        killer.unref();
      } else proc.kill('SIGTERM');
    } catch (_) { }
  }
  startupProcesses.clear();
  try { require('./backend/src/lib/runCommand').terminateActiveCommands(); } catch (_) { }
  try { if (backendServer) backendServer.close(); } catch (_) { }
});

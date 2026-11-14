'use strict';

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec, spawn } = require('child_process');
const https = require('https');
const cors = require('cors');

const jobsRouter    = require('./src/routes/convert');
const firmwareRouter = require('./src/routes/firmware');
const { queuePrecompile, queueAllEnvironments, getCompileStatus } = require('./src/lib/compileQueue');
const { refreshPath } = require('./src/lib/refreshPath');

const app = express();

app.use(cors());
app.use(express.static(path.join(__dirname, '..', 'web')));
app.use('/api/jobs',     jobsRouter);
app.use('/api/firmware', firmwareRouter);

// Fast liveness endpoint for Electron startup polling
app.get('/api/ping', (req, res) => {
  res.json({ ok: true });
});

let healthCache = null;
let healthRefreshing = null;

function checkCmdAsync(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { windowsHide: true, timeout: 8000 }, (err) => resolve(!err));
  });
}

async function refreshHealthCache() {
  if (healthRefreshing) return healthRefreshing;
  if (!healthCache || !healthCache.ffmpeg || !healthCache.pio) {
    try { refreshPath(); } catch (_) {}
  }
  healthRefreshing = Promise.all([
    checkCmdAsync('ffmpeg -version'),
    checkCmdAsync('pio --version'),
    checkCmdAsync('python --version'),
  ]).then(([ffmpeg, pio, python]) => {
    healthCache = { ffmpeg, pio, python, node: true, ts: Date.now() };
    return healthCache;
  }).finally(() => {
    healthRefreshing = null;
  });
  return healthRefreshing;
}

// Health check — returns cached async checks immediately without blocking the event loop
app.get('/api/health', async (req, res) => {
  if (healthCache && ((healthCache.ffmpeg && healthCache.pio) || Date.now() - healthCache.ts < 2000)) {
    res.json(healthCache);
    if (Date.now() - healthCache.ts > 30000) {
      void refreshHealthCache();
    }
    return;
  }
  const result = await refreshHealthCache();
  res.json(result);
});

// Search PlatformIO Library Registry for display libraries by keyword
app.get('/api/boards/search', (req, res) => {
  const q = encodeURIComponent((req.query.q || 'display').trim());
  const url = `https://api.registry.platformio.org/v3/search?query=${q}&limit=20`;

  https.get(url, { headers: { 'User-Agent': 'BadAppleStudio/1.0', 'Accept': 'application/json' } }, (apiRes) => {
    let raw = '';
    apiRes.on('data', chunk => raw += chunk);
    apiRes.on('end', () => {
      try {
        const data = JSON.parse(raw);
        const libs = (data.items || []).map(item => ({
          name:        item.name,
          description: item.description || '',
          version:     item.version?.name || item.latest?.name || '',
          owner:       item.owner?.username || item.owner?.name || '',
          url:         item.homepage || `https://registry.platformio.org/libraries/${item.owner?.username}/${item.name}`,
          lib_deps:    `${item.owner?.username}/${item.name}@^${item.version?.name || item.latest?.name || '*'}`,
        }));
        res.json({ libs });
      } catch (e) {
        res.status(500).json({ error: 'Failed to parse PlatformIO registry response: ' + e.message });
      }
    });
  }).on('error', (e) => {
    res.status(503).json({ error: `Cannot reach PlatformIO registry: ${e.message}` });
  });
});

const BOARD_ID_ALIASES = {
  esp32: 'esp32dev',
  esp32dev: 'esp32dev',
  esp32devkit: 'esp32dev',
  esp32devkitv1: 'esp32dev',
  esp32doitdevkitv1: 'esp32doit-devkit-v1',
  esp32s2: 'esp32-s2-saola-1',
  esp32s2saola1: 'esp32-s2-saola-1',
  esp32s3: 'esp32-s3-devkitc-1',
  esp32s3devkitc1: 'esp32-s3-devkitc-1',
  esp32s3supermini: 'esp32-s3-devkitc-1',
  esp32c3: 'esp32-c3-devkitm-1',
  esp32c3devkitm1: 'esp32-c3-devkitm-1',
  esp32c3supermini: 'esp32-c3-devkitm-1',
  esp32s3box: 'esp32s3box',
  lolins3mini: 'lolin_s3_mini',
  lolin32: 'lolin32',
};

function normalizeBoardId(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  const compact = trimmed.toLowerCase().replace(/[\s_-]+/g, '');
  if (BOARD_ID_ALIASES[compact]) return BOARD_ID_ALIASES[compact];
  return trimmed.toLowerCase().replace(/\s+/g, '-');
}

function inferDriverName(explicitDriver, libs) {
  const upper = String(explicitDriver || '').trim().toUpperCase();
  if (['SSD1306', 'SH1106', 'ILI9341', 'ST7789', 'U8G2_CUSTOM'].includes(upper)) return upper;
  const joined = libs.join(' ').toLowerCase();
  if (joined.includes('st7789')) return 'ST7789';
  if (joined.includes('ili9341') || joined.includes('tft_espi')) return 'ILI9341';
  if (joined.includes('sh1106')) return 'SH1106';
  return 'SSD1306';
}

// Add Custom Board to platformio.ini (supports both Custom Board Builder and Firmware Editor modal)
app.post('/api/boards/add', express.json(), (req, res) => {
  const { library, pins, driver, width, height } = req.body || {};
  const boardId = normalizeBoardId(req.body?.boardId);
  if (!boardId) {
    return res.status(400).json({ error: 'Missing boardId' });
  }

  let envName = req.body?.envName ? String(req.body.envName).trim() : '';
  if (!envName) {
    const rawSuffix = req.body?.name || library || boardId;
    const suffix = String(rawSuffix).replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    envName = `custom-${suffix || boardId}`;
  } else {
    envName = envName.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_');
    if (!envName.startsWith('custom-')) envName = `custom-${envName}`;
  }

  let libs = [];
  if (Array.isArray(req.body?.libDeps)) {
    libs = req.body.libDeps.map((l) => String(l).trim()).filter(Boolean);
  } else if (typeof req.body?.libDeps === 'string' && req.body.libDeps.trim()) {
    libs = [req.body.libDeps.trim()];
  }
  if (library && String(library).trim() && !libs.includes(String(library).trim())) {
    libs.push(String(library).trim());
  }

  let flags = Array.isArray(req.body?.buildFlags)
    ? req.body.buildFlags.map((f) => String(f).trim()).filter(Boolean)
    : [];

  const resolvedDriver = inferDriverName(driver, libs);
  const isSpi = resolvedDriver === 'ST7789' || resolvedDriver === 'ILI9341';

  // Ensure main.cpp receives a valid display backend library & driver define
  if (isSpi) {
    if (!libs.some((l) => l.toLowerCase().includes('tft_espi'))) {
      libs.unshift('Bodmer/TFT_eSPI@^2.5.43');
    }
  } else if (resolvedDriver !== 'U8G2_CUSTOM') {
    if (!libs.some((l) => l.toLowerCase().includes('u8g2'))) {
      libs.unshift('olikraus/U8g2@^2.35.19');
    }
  }

  const defaultW = isSpi ? (resolvedDriver === 'ST7789' ? 170 : 320) : 128;
  const defaultH = isSpi ? (resolvedDriver === 'ST7789' ? 320 : 240) : 64;
  const wVal = parseInt(width, 10) || defaultW;
  const hVal = parseInt(height, 10) || defaultH;

  if (!flags.some((f) => f.startsWith('-DDISPLAY_W='))) flags.push(`-DDISPLAY_W=${wVal}`);
  if (!flags.some((f) => f.startsWith('-DDISPLAY_H='))) flags.push(`-DDISPLAY_H=${hVal}`);

  const hasDriverFlag = flags.some((f) => f.includes('DISPLAY_DRIVER_'));
  if (!hasDriverFlag) {
    if (isSpi) {
      flags.push('-DDISPLAY_DRIVER_TFT=1');
      flags.push('-DUSER_SETUP_LOADED=1');
      flags.push(`-D${resolvedDriver}_DRIVER=1`);
      if (pins?.sda) flags.push(`-DTFT_MOSI=${String(pins.sda).trim()}`);
      if (pins?.scl) flags.push(`-DTFT_SCLK=${String(pins.scl).trim()}`);
      if (pins?.cs)  flags.push(`-DTFT_CS=${String(pins.cs).trim()}`);
      if (pins?.dc)  flags.push(`-DTFT_DC=${String(pins.dc).trim()}`);
      if (pins?.rst) flags.push(`-DTFT_RST=${String(pins.rst).trim()}`);
      if (pins?.bl)  flags.push(`-DTFT_BL=${String(pins.bl).trim()}`);
      if (boardId.includes('esp32')) {
        flags.push('-DUSE_HSPI_PORT=1');
        flags.push('-DSPI_FREQUENCY=40000000');
      }
    } else {
      flags.push(`-DDISPLAY_DRIVER_${resolvedDriver}=1`);
      if (pins?.sda) flags.push(`-DI2C_SDA=${String(pins.sda).trim()}`);
      if (pins?.scl) flags.push(`-DI2C_SCL=${String(pins.scl).trim()}`);
    }
  }

  const pioIniPath = path.join(__dirname, '..', 'firmware', 'platformio.ini');
  let config = '';
  try { config = fs.readFileSync(pioIniPath, 'utf8'); } catch (_) {}

  // Replace existing custom block cleanly if re-adding the same envName
  if (config.includes(`[env:${envName}]`)) {
    const escaped = envName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    config = config.replace(
      new RegExp(`(?:\\r?\\n)*(?:;[^\\r\\n]*\\r?\\n)*\\[env:${escaped}\\][\\s\\S]*?(?=\\r?\\n\\[|$)`, 'g'),
      ''
    );
  }

  let newEnv = `\n\n; ── Custom Board: ${envName.replace('custom-', '')} ──\n[env:${envName}]\nboard = ${boardId}\n`;
  if (libs.length > 0) {
    newEnv += `lib_deps =\n`;
    Array.from(new Set(libs)).forEach((l) => { newEnv += `    ${l}\n`; });
  }
  if (flags.length > 0) {
    newEnv += `build_flags =\n`;
    Array.from(new Set(flags)).forEach((f) => { newEnv += `    ${f}\n`; });
  }

  try {
    fs.writeFileSync(pioIniPath, config.trimEnd() + newEnv, 'utf8');
    queuePrecompile(envName);
    res.json({ success: true, envName, boardId });
  } catch (err) {
    res.status(500).json({ error: 'Failed to write to platformio.ini: ' + err.message });
  }
});

// Persistent status is useful to both the web UI and a packaged app after a
// restart. The compilation itself is started by the backend, not the page.
app.get('/api/boards/:envName/compile-status', (req, res) => {
  res.json(getCompileStatus(req.params.envName));
});

// List installed environments (for the Boards Manager)
app.get('/api/boards/installed', (req, res) => {
  try {
    const { getEnvironments } = require('./src/lib/buildFirmware');
    const envs = getEnvironments();
    res.json(envs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove a custom board from platformio.ini
app.post('/api/boards/remove', express.json(), (req, res) => {
  const { envName } = req.body;
  if (!envName) return res.status(400).json({ error: 'Missing envName' });
  // Safety: only allow removing custom- boards
  if (!envName.startsWith('custom-')) {
    return res.status(403).json({ error: 'Can only remove custom boards. Built-in boards cannot be removed.' });
  }

  const pioIniPath = path.join(__dirname, '..', 'firmware', 'platformio.ini');
  let config = '';
  try { config = fs.readFileSync(pioIniPath, 'utf8'); } catch(e) {
    return res.status(500).json({ error: 'Could not read platformio.ini' });
  }

  if (!config.includes(`[env:${envName}]`)) {
    return res.status(404).json({ error: `Environment [env:${envName}] not found` });
  }

  const escaped = envName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cleanedConfig = config.replace(
    new RegExp(`(?:\\r?\\n)*(?:;[^\\r\\n]*\\r?\\n)*\\[env:${escaped}\\][\\s\\S]*?(?=\\r?\\n\\[|$)`, 'g'),
    ''
  );

  try {
    fs.writeFileSync(pioIniPath, cleanedConfig.trimEnd() + '\n', 'utf8');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to write platformio.ini: ' + err.message });
  }
});

// ── PC App Auto-Updater (GitHub Releases) ─────────────────────────────────────
const GITHUB_LATEST_RELEASE_API =
  'https://api.github.com/repos/Minta1234/bad-apple-studio/releases/latest';

const updateState = {
  state: 'idle', // 'idle' | 'downloading' | 'launching' | 'error'
  progress: 0,
  downloadedMb: 0,
  totalMb: 0,
  version: '',
  error: null,
};

function getCurrentAppVersion() {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return String(pkg.version || '0.0.0').replace(/^(release)?v/i, '');
  } catch (_) {
    return '0.0.0';
  }
}

function parseVersionParts(versionStr) {
  const clean = String(versionStr || '')
    .trim()
    .replace(/^(release)?v/i, '')
    .split('-')[0];
  return clean.split('.').map((p) => {
    const n = parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

function isNewerVersion(current, latest) {
  const cur = parseVersionParts(current);
  const lat = parseVersionParts(latest);
  const count = Math.max(cur.length, lat.length);
  for (let i = 0; i < count; i++) {
    const c = cur[i] || 0;
    const l = lat[i] || 0;
    if (l > c) return true;
    if (l < c) return false;
  }
  return false;
}

function isTrustedGithubUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return (
      host === 'github.com' ||
      host === 'api.github.com' ||
      host.endsWith('.githubusercontent.com')
    );
  } catch (_) {
    return false;
  }
}

function fetchJsonWithRedirect(targetUrl, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      targetUrl,
      {
        headers: {
          'User-Agent': 'BadAppleStudio-PC',
          'Accept': 'application/vnd.github+json',
        },
        timeout: 15000,
      },
      (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects'));
            return;
          }
          const nextUrl = new URL(res.headers.location, targetUrl).toString();
          resolve(fetchJsonWithRedirect(nextUrl, redirectsLeft - 1));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (code < 200 || code >= 300) {
            reject(new Error(`GitHub API HTTP ${code}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error('Invalid JSON from GitHub API: ' + err.message));
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('GitHub request timed out'));
    });
    req.on('error', reject);
  });
}

function downloadFileWithProgress(targetUrl, destPath, onProgress, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      targetUrl,
      {
        headers: { 'User-Agent': 'BadAppleStudio-PC' },
        timeout: 30000,
      },
      (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects while downloading update'));
            return;
          }
          const nextUrl = new URL(res.headers.location, targetUrl).toString();
          resolve(downloadFileWithProgress(nextUrl, destPath, onProgress, redirectsLeft - 1));
          return;
        }
        if (code < 200 || code >= 300) {
          res.resume();
          reject(new Error(`Download failed: HTTP ${code}`));
          return;
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10) || 0;
        let downloadedBytes = 0;
        const partPath = `${destPath}.part`;
        const fileStream = fs.createWriteStream(partPath);

        res.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          if (typeof onProgress === 'function') {
            onProgress(downloadedBytes, totalBytes);
          }
        });

        fileStream.on('finish', () => {
          fileStream.close(() => {
            try {
              if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
              fs.renameSync(partPath, destPath);
              resolve(destPath);
            } catch (err) {
              reject(err);
            }
          });
        });

        const cleanupOnError = (err) => {
          try { fileStream.destroy(); } catch (_) {}
          try { if (fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch (_) {}
          reject(err);
        };

        res.on('error', cleanupOnError);
        fileStream.on('error', cleanupOnError);
        res.pipe(fileStream);
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('Download timed out'));
    });
    req.on('error', reject);
  });
}

async function fetchLatestReleaseInfo() {
  const currentVersion = getCurrentAppVersion();
  const release = await fetchJsonWithRedirect(GITHUB_LATEST_RELEASE_API);
  const tagName = String(release.tag_name || '').trim();
  const latestVersion = tagName.replace(/^(release)?v/i, '');
  const assets = Array.isArray(release.assets) ? release.assets : [];

  const exeAssets = assets.filter((a) => {
    const name = String(a.name || '').toLowerCase();
    return name.endsWith('.exe') && !name.endsWith('.blockmap');
  });
  const installerAsset =
    exeAssets.find((a) => String(a.name || '').toLowerCase().includes('setup')) ||
    exeAssets[0] ||
    null;
  const zipAsset =
    assets.find((a) => String(a.name || '').toLowerCase().endsWith('.zip')) || null;
  const apkAsset =
    assets.find((a) => String(a.name || '').toLowerCase().endsWith('.apk')) || null;

  return {
    currentVersion,
    latestVersion,
    tagName,
    updateAvailable: latestVersion ? isNewerVersion(currentVersion, latestVersion) : false,
    releaseNotes: String(release.body || '').trim(),
    releaseUrl: String(release.html_url || 'https://github.com/Minta1234/bad-apple-studio/releases/latest'),
    installerUrl: installerAsset ? installerAsset.browser_download_url : null,
    installerName: installerAsset ? installerAsset.name : null,
    installerSize: installerAsset ? installerAsset.size : 0,
    zipUrl: zipAsset ? zipAsset.browser_download_url : null,
    apkUrl: apkAsset ? apkAsset.browser_download_url : null,
    platform: process.platform,
    canAutoInstall: process.platform === 'win32' && Boolean(installerAsset && installerAsset.browser_download_url),
  };
}

app.get('/api/update/check', async (req, res) => {
  try {
    const info = await fetchLatestReleaseInfo();
    res.json(info);
  } catch (err) {
    res.status(502).json({
      currentVersion: getCurrentAppVersion(),
      updateAvailable: false,
      error: err.message || 'Failed to check for updates',
    });
  }
});

app.get('/api/update/status', (req, res) => {
  res.json(updateState);
});

app.post('/api/update/install', express.json(), async (req, res) => {
  if (process.platform !== 'win32') {
    return res.status(400).json({
      error: 'Auto-install is only supported on Windows. Please download the update from the release page.',
    });
  }

  if (updateState.state === 'downloading' || updateState.state === 'launching') {
    return res.json({ started: true, ...updateState });
  }

  try {
    let installerUrl = req.body && req.body.installerUrl ? String(req.body.installerUrl) : '';
    let installerName = req.body && req.body.installerName ? String(req.body.installerName) : '';
    let version = req.body && req.body.version ? String(req.body.version) : '';

    if (!installerUrl) {
      const latest = await fetchLatestReleaseInfo();
      if (!latest.installerUrl) {
        return res.status(404).json({ error: 'No Windows installer (.exe) found in latest GitHub release.' });
      }
      installerUrl = latest.installerUrl;
      installerName = latest.installerName || '';
      version = latest.latestVersion || version;
    }

    if (!isTrustedGithubUrl(installerUrl)) {
      return res.status(400).json({ error: 'Untrusted installer URL' });
    }

    const safeFileName =
      installerName && /^[a-zA-Z0-9._-]+\.exe$/i.test(installerName)
        ? installerName
        : 'BadAppleStudio-Setup-Update.exe';
    const destPath = path.join(os.tmpdir(), safeFileName);

    updateState.state = 'downloading';
    updateState.progress = 0;
    updateState.downloadedMb = 0;
    updateState.totalMb = 0;
    updateState.version = version;
    updateState.error = null;

    res.json({ started: true, ...updateState });

    downloadFileWithProgress(installerUrl, destPath, (downloaded, total) => {
      updateState.downloadedMb = Number((downloaded / (1024 * 1024)).toFixed(1));
      updateState.totalMb = total > 0 ? Number((total / (1024 * 1024)).toFixed(1)) : 0;
      updateState.progress = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
    })
      .then((downloadedExe) => {
        updateState.state = 'launching';
        updateState.progress = 100;
        const child = spawn(downloadedExe, [], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
        child.unref();

        // Give the HTTP status poller time to see 'launching', then quit cleanly
        // so the NSIS installer can overwrite Bad Apple Studio.exe without locks.
        setTimeout(() => {
          try {
            if (process.versions && process.versions.electron) {
              const { app: electronApp } = require('electron');
              if (electronApp && typeof electronApp.quit === 'function') {
                electronApp.quit();
              }
            }
          } catch (_) {}
          setTimeout(() => process.exit(0), 500).unref();
        }, 1200).unref();
      })
      .catch((err) => {
        updateState.state = 'error';
        updateState.error = err.message || 'Download failed';
      });
  } catch (err) {
    updateState.state = 'error';
    updateState.error = err.message || 'Failed to start update';
    res.status(500).json({ error: updateState.error });
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(400).json({ error: err.message || 'Error' });
});

const PORT = parseInt(process.env.PORT || '4005', 10);
const HOST = 'localhost';

const server = app.listen(PORT, HOST, () => {
  console.log(`Bad Apple Studio: http://${HOST}:${PORT}`);
  // Warm health cache asynchronously & defer background compiles so the GUI opens first
  setTimeout(() => { void refreshHealthCache(); }, 50).unref();
  setTimeout(() => queueAllEnvironments(), 5000).unref();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Bad Apple Studio] Port ${PORT} is already in use. Another instance may already be running.`);
    // In Electron context, this will be caught by the health-check timeout in main.js
  } else {
    throw err;
  }
});

module.exports = { app, server };

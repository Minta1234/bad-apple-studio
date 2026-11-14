'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const https = require('https');
const cors = require('cors');

const jobsRouter    = require('./src/routes/convert');
const firmwareRouter = require('./src/routes/firmware');
const { queuePrecompile, queueAllEnvironments, getCompileStatus } = require('./src/lib/compileQueue');

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
    exec(cmd, { windowsHide: true, timeout: 4000 }, (err) => resolve(!err));
  });
}

async function refreshHealthCache() {
  if (healthRefreshing) return healthRefreshing;
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
  if (healthCache) {
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

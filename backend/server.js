'use strict';

const express = require('express');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');

const jobsRouter    = require('./src/routes/convert');
const firmwareRouter = require('./src/routes/firmware');

const app = express();

app.use(express.static(path.join(__dirname, '..', 'web')));
app.use('/api/jobs',     jobsRouter);
app.use('/api/firmware', firmwareRouter);

// Health check — verifies required dependencies are installed
app.get('/api/health', (req, res) => {
  const check = (cmd) => {
    try { execSync(cmd, { stdio: 'pipe' }); return true; }
    catch (_) { return false; }
  };
  res.json({
    ffmpeg: check('ffmpeg -version'),
    pio:    check('pio --version'),
    node:   true, // we are running, so node is present
  });
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

const fs = require('fs');

// Add Custom Board to platformio.ini
app.post('/api/boards/add', express.json(), (req, res) => {
  const { envName, boardId, libDeps, buildFlags } = req.body;
  if (!envName || !boardId) {
    return res.status(400).json({ error: 'Missing envName or boardId' });
  }

  const pioIniPath = path.join(__dirname, '..', 'firmware', 'platformio.ini');
  let config = '';
  try { config = fs.readFileSync(pioIniPath, 'utf8'); } catch(e) {}
  
  if (config.includes(`[env:${envName}]`)) {
    return res.status(400).json({ error: `Environment [env:${envName}] already exists in platformio.ini` });
  }

  let newEnv = `\n\n; ── Custom Board: ${envName.replace('custom-', '')} ──\n[env:${envName}]\nboard = ${boardId}\n`;
  if (libDeps) {
    newEnv += `lib_deps =\n`;
    const libs = Array.isArray(libDeps) ? libDeps : [libDeps];
    libs.forEach(l => newEnv += `    ${l}\n`);
  }
  if (buildFlags && buildFlags.length > 0) {
    newEnv += `build_flags =\n`;
    buildFlags.forEach(f => newEnv += `    ${f}\n`);
  }
  
  try {
    fs.appendFileSync(pioIniPath, newEnv);
    res.json({ success: true, envName });
  } catch (err) {
    res.status(500).json({ error: 'Failed to write to platformio.ini: ' + err.message });
  }
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

  // Remove everything from the env section header to the next env section (or EOF)
  const cleanedConfig = config.replace(
    new RegExp(`\\n*;[^\\n]*\\n\\[env:${envName.replace('-', '\\-')}\\][\\s\\S]*?(?=\\n\\[|$)`, 'g'),
    ''
  );

  try {
    fs.writeFileSync(pioIniPath, cleanedConfig, 'utf8');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to write platformio.ini: ' + err.message });
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(400).json({ error: err.message || 'Error' });
});

const PORT = 4005;
const HOST = 'localhost';

const server = app.listen(PORT, HOST, () => {
  console.log(`Bad Apple Studio: http://${HOST}:${PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Bad Apple Studio] Port ${PORT} is already in use. Another instance may already be running.`);
    // In Electron context, this will be caught by the health-check timeout in main.js
  } else {
    throw err;
  }
});

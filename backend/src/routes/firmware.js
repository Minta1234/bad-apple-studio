'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { spawn } = require('child_process');

const { getEnvironments } = require('../lib/buildFirmware');

const router = express.Router();

// The firmware template directory (read-only source of truth)
const FIRMWARE_DIR = path.resolve(__dirname, '../../../firmware');

// Files the editor is allowed to read/write (whitelist — never expose arbitrary FS paths)
const EDITABLE_FILES = [
  { id: 'main',        rel: 'src/main.cpp',      label: 'main.cpp',         lang: 'cpp'  },
  { id: 'platformio',  rel: 'platformio.ini',     label: 'platformio.ini',   lang: 'ini'  },
  { id: 'partitions',  rel: 'partitions.csv',     label: 'partitions.csv',   lang: 'text' },
];

function resolveEditable(id) {
  return EDITABLE_FILES.find((f) => f.id === id) || null;
}

// GET /api/firmware/envs — get dynamically parsed platformio.ini environments
router.get('/envs', (req, res) => {
  res.json(getEnvironments());
});

// GET /api/firmware/files  — list of editable files
router.get('/files', (req, res) => {
  res.json(EDITABLE_FILES.map(({ id, label, lang }) => ({ id, label, lang })));
});

// GET /api/firmware/files/:id  — return file content
router.get('/files/:id', (req, res) => {
  const entry = resolveEditable(req.params.id);
  if (!entry) return res.status(404).json({ error: 'File not found' });

  const fullPath = path.join(FIRMWARE_DIR, entry.rel);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File does not exist on disk' });

  res.type('text/plain').send(fs.readFileSync(fullPath, 'utf8'));
});

// PUT /api/firmware/files/:id  — save edited content
router.put('/files/:id', express.text({ type: '*/*', limit: '2mb' }), (req, res) => {
  const entry = resolveEditable(req.params.id);
  if (!entry) return res.status(404).json({ error: 'File not found' });

  const fullPath = path.join(FIRMWARE_DIR, entry.rel);
  try {
    fs.writeFileSync(fullPath, req.body, 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/firmware/compile  — stream pio build log via Server-Sent Events
// Body JSON: { env: 'esp32-oled096' }
router.post('/compile', express.json(), (req, res) => {
  const envs = getEnvironments();
  const envConfig = envs.find(e => e.id === req.body?.env);
  const env = envConfig ? envConfig.id : (envs[0]?.id || 'esp32-oled096');

  // SSE headers
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  function send(type, data) {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  send('start', { env, message: `pio run -e ${env}` });

  const child = spawn('pio', ['run', '-e', env], {
    cwd:   FIRMWARE_DIR,
    shell: false,
  });

  const pump = (stream) =>
    stream?.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) send('log', { line });
      }
    });

  pump(child.stdout);
  pump(child.stderr);

  child.on('error', (err) => {
    send('error', { message: `Failed to run pio: ${err.message}` });
    res.end();
  });

  child.on('close', (code) => {
    send('done', { code, success: code === 0 });
    res.end();
  });

  // If client disconnects, kill pio
  req.on('close', () => child.kill());
});

module.exports = router;

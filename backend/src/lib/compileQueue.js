'use strict';

// Persistent, server-side precompile queue. Keeping this here (rather than in
// the page) means builds continue when the UI is closed or the app is running
// from the packaged executable.
const fs = require('fs');
const path = require('path');
const { getEnvironments, isBoardPreCompiled, preCompileEnv } = require('./buildFirmware');

const STATE_FILE = path.resolve(__dirname, '../compiles.jsonc');
let running = false;
const queued = new Set();

function readState() {
  try {
    // The file is intentionally JSONC so hand-written comment lines are OK.
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  } catch (_) {
    return [];
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function updateState(env, patch) {
  const state = readState();
  const entry = state.find(item => item.env === env);
  if (entry) Object.assign(entry, patch);
  else state.push({ env, status: 'queued', progress: '', error: null, createdAt: Date.now(), outputFiles: null, ...patch });
  writeState(state);
}

function outputFilesFor(env) {
  const buildDir = path.resolve(__dirname, '../../../firmware/.pio/build', env);
  return ['bootloader.bin', 'partitions.bin', 'firmware.bin']
    .map(file => path.join(buildDir, file))
    .filter(file => fs.existsSync(file));
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queued.size) {
      const env = queued.values().next().value;
      queued.delete(env);
      if (!getEnvironments().some(item => item.id === env)) continue;

      if (isBoardPreCompiled(env)) {
        updateState(env, {
          status: 'done',
          progress: 'Already compiled',
          error: null,
          outputFiles: outputFilesFor(env),
          finishedAt: Date.now(),
        });
        continue;
      }

      updateState(env, { status: 'building', progress: 'Compiling PlatformIO firmware…', error: null });
      const result = await preCompileEnv(env, progress => updateState(env, { status: 'building', progress }));
      updateState(env, result.error
        ? { status: 'error', progress: '', error: result.error }
        : {
          status: 'done',
          progress: 'Ready to flash',
          error: null,
          outputFiles: outputFilesFor(env),
          finishedAt: Date.now(),
        });
    }
  } finally {
    running = false;
  }
}

function queuePrecompile(env) {
  if (!env || !getEnvironments().some(item => item.id === env)) return;
  queued.add(env);
  updateState(env, {
    status: isBoardPreCompiled(env) ? 'done' : 'queued',
    progress: '',
    error: null,
    outputFiles: isBoardPreCompiled(env) ? outputFilesFor(env) : null,
  });
  void drain();
}

function queueAllEnvironments() {
  for (const env of getEnvironments()) queuePrecompile(env.id);
}

function getCompileStatus(env) {
  const entry = readState().find(item => item.env === env);
  return entry || { env, status: isBoardPreCompiled(env) ? 'done' : 'queued', progress: '', error: null };
}

module.exports = { queuePrecompile, queueAllEnvironments, getCompileStatus };

'use strict';

const fs = require('fs');
const path = require('path');
const { run } = require('./runCommand');

const FIRMWARE_TEMPLATE = path.resolve(__dirname, '../../../firmware');
const activeBuilds = new Map();

/**
 * Parse platformio.ini and return all [env:xxx] blocks with display metadata,
 * board info, installed libraries, and a custom-board flag.
 */
function getEnvironments() {
  const iniContent = fs.readFileSync(path.join(FIRMWARE_TEMPLATE, 'platformio.ini'), 'utf8');
  const envs = [];
  let currentEnv = null;
  let inLibDeps = false;

  for (const line of iniContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith(';')) continue;

    // New env section
    const envMatch = trimmed.match(/^\[env:(.+?)\]$/);
    if (envMatch) {
      if (currentEnv) envs.push(currentEnv);
      currentEnv = {
        id:       envMatch[1],
        label:    envMatch[1],
        width:    128,
        height:   64,
        isColor:  false,
        libDeps:  [],
        board:    'esp32dev',
        isCustom: envMatch[1].startsWith('custom-'),
        hasSdCard: false,
        hasBle: false,
      };
      inLibDeps = false;
      continue;
    }

    if (currentEnv) {
      // board identifier
      if (/^board\s*=/.test(trimmed)) {
        currentEnv.board = trimmed.split('=')[1].trim();
      }

      // Start of lib_deps block
      if (/^lib_deps/.test(trimmed)) {
        inLibDeps = true;
        // If value is on the same line: lib_deps = foo/bar@^1.0
        const inline = trimmed.replace(/^lib_deps\s*=\s*/, '').trim();
        if (inline) currentEnv.libDeps.push(inline);
        continue;
      }

      // Continuation of lib_deps (indented lines)
      if (inLibDeps && /^\s/.test(line) && trimmed && !trimmed.startsWith('-D') && !trimmed.startsWith('-I')) {
        currentEnv.libDeps.push(trimmed);
        continue;
      }

      // Any non-indented key ends lib_deps
      if (!/^\s/.test(line) && trimmed) inLibDeps = false;

      // Display dimensions from build_flags
      if (trimmed.startsWith('-DDISPLAY_W=')) currentEnv.width  = parseInt(trimmed.split('=')[1], 10);
      if (trimmed.startsWith('-DDISPLAY_H=')) currentEnv.height = parseInt(trimmed.split('=')[1], 10);

      // Detect color display
      const lower = trimmed.toLowerCase();
      if (lower.includes('tft') || lower.includes('ili9341') || lower.includes('st7789') || lower.includes('color') || lower.includes('arduino_gfx')) {
        currentEnv.isColor = true;
      }
      
      if (trimmed.includes('HAS_SD_CARD')) {
        currentEnv.hasSdCard = true;
      }
      if (trimmed.includes('HAS_BLE')) {
        currentEnv.hasBle = true;
      }
    }
  }
  if (currentEnv) envs.push(currentEnv);
  return envs;
}

function resolveEnv(envName) {
  const found = getEnvironments().find(e => e.id === envName);
  if (!found) throw new Error(`Environment [env:${envName}] not found in platformio.ini`);
  return found;
}

// Copy the firmware template project to a job-specific workspace
// (excluding .pio cache and old data folder so concurrent jobs don't conflict)
function prepareWorkspace(jobDir) {
  const workDir = path.join(jobDir, 'fw');
  fs.cpSync(FIRMWARE_TEMPLATE, workDir, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}.pio`) && !src.includes(`${path.sep}data${path.sep}`),
  });
  fs.mkdirSync(path.join(workDir, 'data'), { recursive: true });
  return workDir;
}

async function compileFirmware({ jobDir, env, videoDatPath, forSdCard, onProgress }) {
  resolveEnv(env);
  const workDir = prepareWorkspace(jobDir);

  if (!forSdCard) {
    fs.copyFileSync(videoDatPath, path.join(workDir, 'data', 'video.dat'));
  }

  // A job must never reach the flasher with an unbuilt board.  This also
  // covers boards added while the browser-side precompile queue is not open.
  const precompileResult = await preCompileEnv(env, onProgress);
  if (precompileResult.error) throw new Error(`Firmware compile failed for [env:${env}]: ${precompileResult.error}`);
  const precompiled = true;
  const globalBuildOut = path.join(FIRMWARE_TEMPLATE, '.pio', 'build', env);
  const localBuildOut = path.join(workDir, '.pio', 'build', env);

  if (precompiled) {
    onProgress?.('Firmware is already precompiled, skipping build step...');
  } else {
    onProgress?.('Compiling firmware (first run may be slow due to toolchain download)...');
    await run('pio', ['run', '-e', env], { cwd: workDir });
  }

  onProgress?.('Building SPIFFS image...');
  await run('pio', ['run', '-t', 'buildfs', '-e', env], { cwd: workDir });

  const files = {
    bootloader: precompiled ? path.join(globalBuildOut, 'bootloader.bin') : path.join(localBuildOut, 'bootloader.bin'),
    partitions: precompiled ? path.join(globalBuildOut, 'partitions.bin') : path.join(localBuildOut, 'partitions.bin'),
    firmware:   precompiled ? path.join(globalBuildOut, 'firmware.bin') : path.join(localBuildOut, 'firmware.bin'),
    spiffs:     path.join(localBuildOut, 'spiffs.bin'),
  };

  for (const [name, p] of Object.entries(files)) {
    if (!fs.existsSync(p)) {
      throw new Error(`Compile succeeded but ${name} not found at ${p} (check pio log)`);
    }
  }

  return files;
}

/**
 * Check whether a given environment has already been compiled.
 * Returns true if firmware.bin exists in .pio/build/<env>/.
 */
function isBoardPreCompiled(envName) {
  const binPath = path.join(FIRMWARE_TEMPLATE, '.pio', 'build', envName, 'firmware.bin');
  return fs.existsSync(binPath);
}

/**
 * Pre-compile a single environment if it hasn't been compiled yet.
 * Returns { compiled: true/false, error?: string }.
 * The optional onProgress callback receives log lines.
 */
async function preCompileEnv(envName, onProgress) {
  // Validate that the env exists in platformio.ini
  resolveEnv(envName);

  if (isBoardPreCompiled(envName)) {
    return { compiled: false, reason: 'already-compiled' };
  }

  // Two conversion jobs and the background queue may request the same board
  // at once. PlatformIO cannot safely write to the same .pio/build directory
  // concurrently, so share one build promise per environment.
  if (activeBuilds.has(envName)) return activeBuilds.get(envName);

  const build = (async () => {
    onProgress?.(`Compiling firmware for [env:${envName}]...`);
    try {
      await run('pio', ['run', '-e', envName], { cwd: FIRMWARE_TEMPLATE });
      onProgress?.(`✓ [env:${envName}] compiled successfully.`);
      return { compiled: true };
    } catch (err) {
      onProgress?.(`✗ [env:${envName}] compile failed: ${err.message}`);
      return { compiled: false, error: err.message };
    } finally {
      activeBuilds.delete(envName);
    }
  })();
  activeBuilds.set(envName, build);
  return build;
}

/**
 * Pre-compile ALL environments that don't have binaries yet.
 * Runs sequentially to avoid overwhelming the machine.
 * Returns an array of { env, compiled, error? } results.
 */
async function preCompileAllEnvs(onProgress) {
  const envs = getEnvironments();
  const results = [];

  for (const env of envs) {
    const result = await preCompileEnv(env.id, onProgress);
    results.push({ env: env.id, ...result });
  }

  return results;
}

module.exports = { compileFirmware, getEnvironments, resolveEnv, isBoardPreCompiled, preCompileEnv, preCompileAllEnvs };

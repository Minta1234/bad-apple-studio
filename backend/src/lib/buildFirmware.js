'use strict';

const fs = require('fs');
const path = require('path');
const { run } = require('./runCommand');

const FIRMWARE_TEMPLATE = path.resolve(__dirname, '../../../firmware');

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
      if (lower.includes('tft') || lower.includes('ili9341') || lower.includes('st7789') || lower.includes('color')) {
        currentEnv.isColor = true;
      }
      
      if (trimmed.includes('HAS_SD_CARD')) {
        currentEnv.hasSdCard = true;
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

  onProgress?.('Compiling firmware (first run may be slow due to toolchain download)...');
  await run('pio', ['run', '-e', env], { cwd: workDir });

  onProgress?.('Building SPIFFS image...');
  await run('pio', ['run', '-t', 'buildfs', '-e', env], { cwd: workDir });

  const buildOut = path.join(workDir, '.pio', 'build', env);
  const files = {
    bootloader: path.join(buildOut, 'bootloader.bin'),
    partitions: path.join(buildOut, 'partitions.bin'),
    firmware:   path.join(buildOut, 'firmware.bin'),
    spiffs:     path.join(buildOut, 'spiffs.bin'),
  };

  for (const [name, p] of Object.entries(files)) {
    if (!fs.existsSync(p)) {
      throw new Error(`Compile succeeded but ${name} not found at ${p} (check pio log)`);
    }
  }

  return files;
}

module.exports = { compileFirmware, getEnvironments, resolveEnv };

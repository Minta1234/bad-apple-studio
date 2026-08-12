'use strict';

const fs = require('fs');
const path = require('path');
const { run } = require('./runCommand');

const FIRMWARE_TEMPLATE = path.resolve(__dirname, '../../../firmware');

const DISPLAY_ENV = {
  '0.96':      'esp32-oled096',
  '1.3':       'esp32-oled130',
  '2432s028':  'esp32-ili9341',  // ESP32-2432S028 "Cheap Yellow Display"
};

// Resolution per display key — used in convert.js to resize the video correctly
const DISPLAY_RESOLUTION = {
  '0.96':      { width: 128, height: 64  },
  '1.3':       { width: 128, height: 64  },
  '2432s028':  { width: 320, height: 240 },
};

// Whitelist to prevent clients from injecting arbitrary values as the -e argument
function resolveEnv(display) {
  const env = DISPLAY_ENV[display];
  if (!env) throw new Error(`display must be one of: ${Object.keys(DISPLAY_ENV).join(', ')}`);
  return env;
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

async function compileFirmware({ jobDir, display, videoDatPath, forSdCard, onProgress }) {
  const env = resolveEnv(display);
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
    firmware: path.join(buildOut, 'firmware.bin'),
    spiffs: path.join(buildOut, 'spiffs.bin'),
  };

  for (const [name, p] of Object.entries(files)) {
    if (!fs.existsSync(p)) {
      throw new Error(`Compile succeeded but ${name} not found at ${p} (check pio log)`);
    }
  }

  return files;
}

module.exports = { compileFirmware, DISPLAY_ENV, DISPLAY_RESOLUTION };

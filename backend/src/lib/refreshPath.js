'use strict';

/**
 * refreshPath.js — Refresh process.env.PATH from the Windows registry.
 *
 * After winget (or pip) installs a tool, the PATH in the *current* process
 * is stale.  Windows only updates PATH for newly-opened terminals.
 *
 * This module reads the latest User + System PATH values from the registry,
 * expands %VAR% placeholders, adds standard Windows tool fallback locations,
 * and updates process.env.PATH in-place so the app finds newly-installed
 * binaries immediately without restarting.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Expand %VAR% placeholders against process.env (case-insensitively on Windows).
 */
function expandEnvVars(str, envMap) {
  if (!str) return '';
  return String(str).replace(/%([^%]+)%/g, (match, name) => {
    const val = envMap[name.toLowerCase()];
    return val !== undefined ? val : match;
  });
}

function buildEnvMap() {
  const map = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) map[k.toLowerCase()] = v;
  }
  return map;
}

/**
 * Query a single registry key and return its value, or '' on failure.
 */
function regQuery(regExe, hive, valueName) {
  try {
    const raw = execSync(
      `"${regExe}" query "${hive}" /v ${valueName}`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true, timeout: 3000 }
    );
    const match = raw.match(/REG_(?:EXPAND_)?SZ\s+(.+)/i);
    return match ? match[1].trim() : '';
  } catch (_) {
    return '';
  }
}

/**
 * Collect common Windows install directories for Python, PlatformIO, and FFmpeg
 * in case the app was launched with a stripped environment or unexpanded PATH.
 */
function getFallbackToolDirs(envMap) {
  const dirs = [];
  const home = os.homedir();
  const localAppData = envMap.localappdata || path.join(home, 'AppData', 'Local');
  const systemRoot = envMap.systemroot || 'C:\\Windows';

  dirs.push(path.join(home, '.platformio', 'penv', 'Scripts'));
  dirs.push(path.join(localAppData, 'Microsoft', 'WinGet', 'Links'));

  const pythonRoot = path.join(localAppData, 'Programs', 'Python');
  try {
    if (fs.existsSync(pythonRoot)) {
      for (const entry of fs.readdirSync(pythonRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && /^python/i.test(entry.name)) {
          const pyDir = path.join(pythonRoot, entry.name);
          dirs.push(path.join(pyDir, 'Scripts'));
          dirs.push(pyDir);
        }
      }
    }
  } catch (_) {}

  const toolsRoot = 'C:\\Tools';
  try {
    if (fs.existsSync(toolsRoot)) {
      for (const entry of fs.readdirSync(toolsRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && /ffmpeg/i.test(entry.name)) {
          const ffBase = path.join(toolsRoot, entry.name);
          dirs.push(path.join(ffBase, 'bin'));
          try {
            for (const sub of fs.readdirSync(ffBase, { withFileTypes: true })) {
              if (sub.isDirectory()) {
                dirs.push(path.join(ffBase, sub.name, 'bin'));
              }
            }
          } catch (_) {}
        }
      }
    }
  } catch (_) {}

  dirs.push(path.join(systemRoot, 'System32'));

  return dirs.filter((d) => {
    try { return fs.existsSync(d); } catch (_) { return false; }
  });
}

/**
 * Read the current User + System PATH from the Windows registry,
 * expand %VAR% placeholders, merge with existing PATH and tool fallbacks,
 * and update process.env.PATH / process.env.Path in-place.
 */
function refreshPath() {
  if (process.platform !== 'win32') return;

  const envMap = buildEnvMap();
  const sysRoot = envMap.systemroot || 'C:\\Windows';
  const defaultReg = path.join(sysRoot, 'System32', 'reg.exe');
  const regExe = fs.existsSync(defaultReg) ? defaultReg : 'reg';

  const systemPath = regQuery(
    regExe,
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
    'Path'
  );
  const userPath = regQuery(regExe, 'HKCU\\Environment', 'Path');

  const currentRaw = (process.env.PATH || process.env.Path || '').split(';');
  const registryRaw = [
    ...systemPath.split(';'),
    ...userPath.split(';'),
  ];
  const fallbackDirs = getFallbackToolDirs(envMap);

  const candidates = [
    ...currentRaw,
    ...registryRaw,
    ...fallbackDirs,
  ]
    .map((p) => expandEnvVars(p, envMap).trim())
    .filter(Boolean);

  const merged = [];
  const seen = new Set();
  for (const entry of candidates) {
    const key = entry.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(entry);
    }
  }

  const joined = merged.join(';');
  process.env.PATH = joined;
  process.env.Path = joined;
}

module.exports = { refreshPath };

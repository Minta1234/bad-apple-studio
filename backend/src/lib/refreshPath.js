'use strict';

/**
 * refreshPath.js — Refresh process.env.PATH from the Windows registry.
 *
 * After winget (or pip) installs a tool, the PATH in the *current* process
 * is stale.  Windows only updates PATH for newly-opened terminals.
 *
 * This module reads the latest User + System PATH values from the registry
 * and updates process.env.PATH in-place, so the app can find newly-installed
 * binaries without restarting.
 */

const { execSync } = require('child_process');

/**
 * Query a single registry key and return its value, or '' on failure.
 */
function regQuery(hive, valueName) {
  try {
    // `reg query` outputs lines like:
    //     Path    REG_EXPAND_SZ    C:\Users\...
    const raw = execSync(
      `reg query "${hive}" /v ${valueName}`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true }
    );
    const match = raw.match(/REG_(?:EXPAND_)?SZ\s+(.+)/i);
    return match ? match[1].trim() : '';
  } catch (_) {
    return '';
  }
}

/**
 * Read the current User + System PATH from the Windows registry,
 * merge them, and update process.env.PATH so that newly-installed
 * tools (Node, Python, FFmpeg, PIO, Git, etc.) are immediately visible
 * to child_process.exec / spawn calls.
 */
function refreshPath() {
  const systemPath = regQuery(
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
    'Path'
  );
  const userPath = regQuery('HKCU\\Environment', 'Path');

  if (!systemPath && !userPath) return; // non-Windows or unreadable — skip

  // Also keep any in-process additions (e.g. from pip --user) that may
  // already be on the current PATH but not yet persisted to the registry.
  const currentEntries = new Set(
    (process.env.PATH || '').split(';').map(p => p.trim().toLowerCase()).filter(Boolean)
  );

  const freshEntries = [
    ...systemPath.split(';'),
    ...userPath.split(';'),
  ].map(p => p.trim()).filter(Boolean);

  // Merge: fresh entries first (in their registry order), then any
  // extras that were only in the old process.env.PATH.
  const merged = [];
  const seen = new Set();
  for (const entry of freshEntries) {
    const key = entry.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(entry);
    }
  }
  // Append old extras that aren't in the fresh set
  for (const entry of (process.env.PATH || '').split(';')) {
    const key = entry.trim().toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      merged.push(entry.trim());
    }
  }

  process.env.PATH = merged.join(';');
}

module.exports = { refreshPath };

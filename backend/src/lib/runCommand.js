'use strict';

const { spawn } = require('child_process');
const activeChildren = new Set();

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const { onOutput, ...spawnOpts } = opts;
    const child = spawn(cmd, args, { ...spawnOpts, shell: false });
    activeChildren.add(child);
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (d) => {
      const text = d.toString();
      stdout += text;
      onOutput?.(text);
    });
    child.stderr?.on('data', (d) => {
      const text = d.toString();
      stderr += text;
      onOutput?.(text);
    });

    child.on('error', (err) => {
      activeChildren.delete(child);
      reject(new Error(`can't ran Command ${cmd}: ${err.message}`));
    });

    child.on('close', (code) => {
      activeChildren.delete(child);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${cmd} ${args.join(' ')} exit code ${code}\n${stderr || stdout}`));
      }
    });
  });
}

function terminateActiveCommands() {
  for (const child of activeChildren) {
    try {
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
        killer.unref();
      } else {
        child.kill('SIGTERM');
      }
    } catch (_) { /* process may have exited between enumeration and kill */ }
  }
  activeChildren.clear();
}

module.exports = { run, terminateActiveCommands };

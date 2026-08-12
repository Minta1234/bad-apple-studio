'use strict';

const { spawn } = require('child_process');

// รัน external command แบบ promise พร้อม capture stdout/stderr
// ไม่ใช้ exec()/shell string เพื่อกัน shell injection — ส่ง args เป็น array เสมอ
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, shell: false });
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      reject(new Error(`can't ran Command ${cmd}: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${cmd} ${args.join(' ')} exit code ${code}\n${stderr || stdout}`));
      }
    });
  });
}

module.exports = { run };

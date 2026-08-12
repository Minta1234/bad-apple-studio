'use strict';

const fs = require('fs');
const path = require('path');
const { run } = require('./runCommand');

const FIRMWARE_TEMPLATE = path.resolve(__dirname, '../../../firmware');

const DISPLAY_ENV = {
  '0.96': 'esp32-oled096',
  '1.3': 'esp32-oled130',
};

// whitelist ป้องกัน client ส่งค่า display แปลก ๆ เข้าไปกลายเป็น -e argument เอง
function resolveEnv(display) {
  const env = DISPLAY_ENV[display];
  if (!env) throw new Error(`display ต้องเป็นหนึ่งใน: ${Object.keys(DISPLAY_ENV).join(', ')}`);
  return env;
}

// คัดลอก template firmware project ไป workspace เฉพาะของ job นี้ (ไม่รวม .pio cache
// เดิม/โฟลเดอร์ data เดิม เพื่อไม่ให้ job ชนกันตอนรันพร้อมกัน)
function prepareWorkspace(jobDir) {
  const workDir = path.join(jobDir, 'fw');
  fs.cpSync(FIRMWARE_TEMPLATE, workDir, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}.pio`) && !src.includes(`${path.sep}data${path.sep}`),
  });
  fs.mkdirSync(path.join(workDir, 'data'), { recursive: true });
  return workDir;
}

async function compileFirmware({ jobDir, display, videoDatPath, onProgress }) {
  const env = resolveEnv(display);
  const workDir = prepareWorkspace(jobDir);

  fs.copyFileSync(videoDatPath, path.join(workDir, 'data', 'video.dat'));

  onProgress?.('กำลัง compile firmware (ครั้งแรกอาจช้าเพราะดาวน์โหลด toolchain)...');
  await run('pio', ['run', '-e', env], { cwd: workDir });

  onProgress?.('กำลังสร้าง SPIFFS image...');
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
      throw new Error(`compile เสร็จแต่หาไฟล์ ${name} ไม่เจอที่ ${p} (ตรวจ log ของ pio)`);
    }
  }

  return files;
}

module.exports = { compileFirmware, DISPLAY_ENV };

'use strict';

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { createJob, updateJob, getJob } = require('../jobs');
const { extractFrames } = require('../lib/ffmpegExtract');
const { packFrames } = require('../lib/packFrames');
const { compileFirmware, DISPLAY_ENV } = require('../lib/buildFirmware');

const router = express.Router();

const JOBS_ROOT = path.join(__dirname, '..', '..', 'jobs');
fs.mkdirSync(JOBS_ROOT, { recursive: true });

const WIDTH = 128;
const HEIGHT = 64;

// partition offsets ต้องตรงกับ firmware/partitions.csv เป๊ะ ๆ
const PART_OFFSETS = {
  bootloader: 4096,
  partitions: 32768,
  firmware: 65536,
  spiffs: 2686976,
};

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const jobId = req.jobId; // ตั้งไว้ก่อนถึง multer middleware ด้านล่าง
      const dir = path.join(JOBS_ROOT, jobId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, 'upload' + path.extname(file.originalname || '')),
  }),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB — กันอัปโหลดไฟล์ใหญ่เกินจำเป็น
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('video/')) {
      return cb(new Error('ไฟล์ที่อัปโหลดต้องเป็นวิดีโอเท่านั้น'));
    }
    cb(null, true);
  },
});

function assignJobId(req, res, next) {
  req.jobId = crypto.randomUUID();
  next();
}

router.post('/convert', assignJobId, upload.single('video'), async (req, res) => {
  const jobId = req.jobId;

  if (!req.file) {
    return res.status(400).json({ error: 'ไม่พบไฟล์วิดีโอที่อัปโหลด (field name ต้องชื่อ "video")' });
  }

  const display = req.body.display;
  if (!DISPLAY_ENV[display]) {
    return res.status(400).json({ error: `display ต้องเป็นหนึ่งใน: ${Object.keys(DISPLAY_ENV).join(', ')}` });
  }

  const fps = clampInt(req.body.fps, 1, 30, 12);
  const threshold = clampInt(req.body.threshold, 0, 255, 128);
  const invert = req.body.invert === 'true' || req.body.invert === true;

  createJob(jobId);
  res.status(202).json({ jobId });

  // ประมวลผลแบบ background ไม่ block HTTP response (compile firmware ใช้เวลาเป็นนาที)
  processJob(jobId, req.file.path, { display, fps, threshold, invert }).catch((err) => {
    updateJob(jobId, { status: 'error', error: err.message });
  });
});

router.get('/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'ไม่พบ job นี้' });
  res.json(job);
});

router.get('/:id/manifest.json', (req, res) => {
  const job = getJob(req.params.id);
  if (!job || job.status !== 'done') {
    return res.status(404).json({ error: 'job ยังไม่เสร็จ หรือไม่พบ job' });
  }
  res.json({
    name: 'Bad Apple ESP32',
    version: '1.0.0',
    builds: [
      {
        chipFamily: 'ESP32',
        parts: [
          { path: `files/bootloader.bin`, offset: PART_OFFSETS.bootloader },
          { path: `files/partitions.bin`, offset: PART_OFFSETS.partitions },
          { path: `files/firmware.bin`, offset: PART_OFFSETS.firmware },
          { path: `files/spiffs.bin`, offset: PART_OFFSETS.spiffs },
        ],
      },
    ],
  });
});

const ALLOWED_FILES = new Set(['bootloader.bin', 'partitions.bin', 'firmware.bin', 'spiffs.bin']);

router.get('/:id/files/:name', (req, res) => {
  const name = path.basename(req.params.name); // กัน path traversal เด็ดขาด
  if (!ALLOWED_FILES.has(name)) return res.status(400).end();

  const job = getJob(req.params.id);
  if (!job || job.status !== 'done') return res.status(404).end();

  const filePath = path.join(JOBS_ROOT, req.params.id, 'output', name);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.sendFile(filePath);
});

async function processJob(jobId, uploadedVideoPath, { display, fps, threshold, invert }) {
  const jobDir = path.join(JOBS_ROOT, jobId);
  const framesDir = path.join(jobDir, 'frames');
  const videoDatPath = path.join(jobDir, 'video.dat');
  const outputDir = path.join(jobDir, 'output');
  fs.mkdirSync(outputDir, { recursive: true });

  updateJob(jobId, { status: 'extracting', progress: 'กำลังแตกเฟรมจากวิดีโอด้วย ffmpeg...' });
  const frames = await extractFrames(uploadedVideoPath, framesDir, { fps, width: WIDTH, height: HEIGHT });

  updateJob(jobId, { status: 'packing', progress: `กำลังเข้ารหัส ${frames.length} เฟรมเป็น RLE...` });
  packFrames(frames, videoDatPath, { width: WIDTH, height: HEIGHT, fps, threshold, invert });

  // เคลียร์ไฟล์ชั่วคราวที่ไม่ใช้แล้วเพื่อประหยัดพื้นที่ดิสก์
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.rmSync(uploadedVideoPath, { force: true });

  updateJob(jobId, { status: 'building', progress: 'กำลัง compile firmware...' });
  const files = await compileFirmware({
    jobDir,
    display,
    videoDatPath,
    onProgress: (msg) => updateJob(jobId, { progress: msg }),
  });

  for (const [name, srcPath] of Object.entries(files)) {
    fs.copyFileSync(srcPath, path.join(outputDir, `${name}.bin`));
  }

  updateJob(jobId, { status: 'done', progress: 'เสร็จแล้ว พร้อมแฟลช' });
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

module.exports = router;

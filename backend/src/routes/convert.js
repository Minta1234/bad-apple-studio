'use strict';

const express = require('express');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const { execSync } = require('child_process');

const { createJob, updateJob, getJob } = require('../jobs');
const { extractFrames }                = require('../lib/ffmpegExtract');
const { packFrames }                   = require('../lib/packFrames');
const { extractFramesColor, packFramesColor } = require('../lib/packFramesColor');
const { compileFirmware, DISPLAY_ENV, DISPLAY_RESOLUTION } = require('../lib/buildFirmware');

const router = express.Router();

const JOBS_ROOT = path.join(__dirname, '..', '..', 'jobs');
fs.mkdirSync(JOBS_ROOT, { recursive: true });

// Resolution is looked up per display — see DISPLAY_RESOLUTION in buildFirmware.js

// Partition offsets must match firmware/partitions.csv exactly
const PART_OFFSETS = {
  bootloader: 4096,      // 0x1000
  partitions: 32768,     // 0x8000
  firmware:   65536,     // 0x10000
  spiffs:     1441792,   // 0x160000 (Updated from partitions.csv)
};

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const jobId = req.jobId; // set before multer middleware below
      const dir = path.join(JOBS_ROOT, jobId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, 'upload' + path.extname(file.originalname || '')),
  }),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB max upload size
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('video/') && !file.mimetype.startsWith('image/')) {
      return cb(new Error('Uploaded file must be a video or image'));
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
    return res.status(400).json({ error: 'No video file found in upload (field name must be "video")' });
  }

  const display = req.body.display;
  if (!DISPLAY_ENV[display]) {
    return res.status(400).json({ error: `display must be one of: ${Object.keys(DISPLAY_ENV).join(', ')}` });
  }

  const fps       = clampInt(req.body.fps,       1,   30,  12);
  const threshold = clampInt(req.body.threshold,  0,  255, 128);
  const invert    = req.body.invert === 'true' || req.body.invert === true;
  const isColor   = req.body.colorMode === 'true' && display === '2432s028';
  // forSdCard: skip SPIFFS size limit and always use full 320x240 resolution
  const forSdCard = req.body.forSdCard === 'true' && isColor;

  const { width: W, height: H } = DISPLAY_RESOLUTION[display];

  createJob(jobId);
  res.status(202).json({ jobId });

  // Process in background so we don't block the HTTP response (firmware compile can take minutes)
  processJob(jobId, req.file.path, { display, fps, threshold, invert, isColor, forSdCard, width: W, height: H }).catch((err) => {
    updateJob(jobId, { status: 'error', error: err.message });
  });
});

router.get('/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

router.get('/:id/manifest.json', (req, res) => {
  const job = getJob(req.params.id);
  if (!job || job.status !== 'done') {
    return res.status(404).json({ error: 'Job not finished or not found' });
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
          { path: `files/firmware.bin`,   offset: PART_OFFSETS.firmware   },
          { path: `files/spiffs.bin`,     offset: PART_OFFSETS.spiffs     },
        ],
      },
    ],
  });
});

const ALLOWED_FILES = new Set(['bootloader.bin', 'partitions.bin', 'firmware.bin', 'spiffs.bin', 'video.dat']);

router.get('/:id/files/:name', (req, res) => {
  const name = path.basename(req.params.name); // prevent path traversal
  if (!ALLOWED_FILES.has(name)) return res.status(400).end();

  const job = getJob(req.params.id);
  if (!job || job.status !== 'done') return res.status(404).end();

  const isVideoDat = name === 'video.dat';
  const filePath = path.join(JOBS_ROOT, req.params.id, isVideoDat ? '' : 'output', name);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  
  if (isVideoDat) {
    res.download(filePath, 'video.dat'); // Force download
  } else {
    res.sendFile(filePath);
  }
});

async function processJob(jobId, uploadedVideoPath, { display, fps, threshold, invert, isColor, forSdCard, width: W, height: H }) {
  const jobDir      = path.join(JOBS_ROOT, jobId);
  const framesDir   = path.join(jobDir, 'frames');
  const videoDatPath = path.join(jobDir, 'video.dat');
  const outputDir   = path.join(jobDir, 'output');
  fs.mkdirSync(outputDir, { recursive: true });

  if (isColor) {
    updateJob(jobId, { status: 'extracting', progress: 'Calculating video duration for auto-scaling...' });
    let duration = 0;
    try {
      const out = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${uploadedVideoPath}"`);
      duration = parseFloat(out.toString().trim());
      if (Number.isNaN(duration)) duration = 0;
    } catch (e) {
      duration = 0;
    }

    const totalFrames = Math.ceil(duration * fps);

    if (forSdCard) {
      // SD card has no size limit — always use full 320x240 resolution for maximum quality
      W = 320;
      H = 240;
    } else {
      // SPIFFS has significant overhead (up to 25%). Our partition is ~2.68MB.
      // So 1.9MB is a very safe limit to guarantee mkspiffs won't fail.
      const MAX_SPIFFS_SIZE = 1900000;

      if (totalFrames > 0) {
        const maxBytesPerFrame = MAX_SPIFFS_SIZE / totalFrames;
        const maxPixels = maxBytesPerFrame / 2;

        const SCALES = [1, 2, 4, 5, 8, 10];
        let selectedScale = null;

        for (const scale of SCALES) {
          const testW = 320 / scale;
          const testH = 240 / scale;
          if ((testW * testH) <= maxPixels) {
            selectedScale = scale;
            W = testW;
            H = testH;
            break;
          }
        }

        if (!selectedScale) {
          throw new Error(`Video is ${duration.toFixed(1)}s long and cannot be scaled down any further. Please use a shorter video or reduce FPS.`);
        }
      }
    }

    const ext = path.extname(uploadedVideoPath).toLowerCase();
    const isImage = ['.jpg', '.jpeg', '.png', '.bmp', '.webp', '.gif'].includes(ext);
    updateJob(jobId, { status: 'extracting', progress: `Converting video to RGB565 raw (${W}x${H})...` });
    const rawFile = await extractFramesColor(uploadedVideoPath, framesDir, { fps, width: W, height: H, isImage, duration });

    updateJob(jobId, { status: 'packing', progress: `Packing color frames into video.dat...` });
    packFramesColor(rawFile, videoDatPath, { width: W, height: H, fps });
  } else {
    const ext = path.extname(uploadedVideoPath).toLowerCase();
    const isImage = ['.jpg', '.jpeg', '.png', '.bmp', '.webp', '.gif'].includes(ext);
    updateJob(jobId, { status: 'extracting', progress: 'Extracting frames from video with ffmpeg...' });
    const frames = await extractFrames(uploadedVideoPath, framesDir, { fps, width: W, height: H, isImage, duration });

    updateJob(jobId, { status: 'packing', progress: `RLE-encoding ${frames.length} frames...` });
    packFrames(frames, videoDatPath, { width: W, height: H, fps, threshold, invert });
  }

  // Clean up temporary files to save disk space
  fs.rmSync(framesDir,           { recursive: true, force: true });
  fs.rmSync(uploadedVideoPath,   { force: true });

  updateJob(jobId, { status: 'building', progress: 'Compiling firmware...' });
  const files = await compileFirmware({
    jobDir,
    display,
    videoDatPath,
    forSdCard,
    onProgress: (msg) => updateJob(jobId, { progress: msg }),
  });

  for (const [name, srcPath] of Object.entries(files)) {
    fs.copyFileSync(srcPath, path.join(outputDir, `${name}.bin`));
  }

  updateJob(jobId, { status: 'done', progress: 'Done — ready to flash' });
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

module.exports = router;

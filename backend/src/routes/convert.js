'use strict';

const express = require('express');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const { execSync } = require('child_process');

const { createJob, updateJob, appendJobLog, getJob } = require('../jobs');
const { extractFrames }                = require('../lib/ffmpegExtract');
const { packFrames }                   = require('../lib/packFrames');
const { extractFramesColor, packFramesColor } = require('../lib/packFramesColor');
const { compileFirmware, getEnvironments } = require('../lib/buildFirmware');

const router = express.Router();

const JOBS_ROOT = path.join(__dirname, '..', '..', 'jobs');
fs.mkdirSync(JOBS_ROOT, { recursive: true });

// Parse firmware/partitions.csv to find the actual SPIFFS partition size in bytes
// Uses the hex offset+size to compute usable bytes, applying 75% safety for mkspiffs overhead
function getSpiffsMaxBytes() {
  try {
    const csvPath = path.resolve(__dirname, '../../../firmware/partitions.csv');
    const lines = fs.readFileSync(csvPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || !trimmed) continue;
      const parts = trimmed.split(',').map(s => s.trim());
      if (parts[0] === 'spiffs') {
        const size = parseInt(parts[4], 16);
        if (!isNaN(size)) return Math.floor(size * 0.65); // 65% to account for mkspiffs overhead
      }
    }
  } catch (_) {}
  return 1746534; // fallback: 2.68MB × 0.65
}

// app/partitions/spiffs offsets come from firmware/partitions.csv and are
// identical across every Espressif chip — only the bootloader load address
// differs per silicon family, so that one has to be resolved per-board.
const PART_OFFSETS = {
  partitions: 32768,     // 0x8000
  firmware:   65536,     // 0x10000
  spiffs:     1441792,   // 0x160000
};

// Maps the `board =` value from platformio.ini -> esp-web-tools chipFamily
// + bootloader flash offset. esp-web-tools refuses to install a manifest
// whose chipFamily doesn't match what it reads back from the connected
// chip, and a wrong bootloader offset produces a device that won't boot
// even if the flash "succeeds" — so both must be derived per-env, never
// hardcoded to classic ESP32 values.
// Ref: https://docs.espressif.com/projects/esptool/en/latest/esp32s3/advanced-topics/firmware-image-format.html
const CHIP_INFO = {
  esp32dev:             { chipFamily: 'ESP32',    bootloaderOffset: 0x1000 },
  'esp32s3box':         { chipFamily: 'ESP32-S3', bootloaderOffset: 0x0    },
  'lolin_s3_mini':      { chipFamily: 'ESP32-S3', bootloaderOffset: 0x0    },
  'esp32-s3-devkitc-1': { chipFamily: 'ESP32-S3', bootloaderOffset: 0x0    },
  'esp32-c3-devkitm-1': { chipFamily: 'ESP32-C3', bootloaderOffset: 0x0    },
  'esp32-s2-saola-1':   { chipFamily: 'ESP32-S2', bootloaderOffset: 0x1000 },
};

function getChipInfo(board) {
  const info = CHIP_INFO[board];
  if (!info) {
    // Fail loudly instead of silently flashing wrong offsets to an
    // unmapped board — add the board to CHIP_INFO instead of relaxing this.
    throw new Error(`Unknown platformio board "${board}" — add it to CHIP_INFO in convert.js`);
  }
  return info;
}

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
  // Disk storage streams uploads; do not keep a large Android video in RAM.
  // Retain a finite limit so a damaged/accidental file cannot fill the drive.
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GiB
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

  const envs = getEnvironments();
  const displayEnv = req.body.display; // Now this is the env string directly (e.g. 'esp32-oled096')
  const envConfig = envs.find(e => e.id === displayEnv);
  
  if (!envConfig) {
    return res.status(400).json({ error: `display must be a valid environment from platformio.ini` });
  }

  let chipInfo;
  try {
    chipInfo = getChipInfo(envConfig.board);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  let fps = parseInt(req.body.fps, 10);
  
  if (Number.isNaN(fps) || fps <= 0) {
    try {
      const { execSync } = require('child_process');
      const fpsOut = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=noprint_wrappers=1:nokey=1 "${req.file.path}"`);
      const [num, den] = fpsOut.toString().trim().split('/');
      fps = Math.round((parseFloat(num) / parseFloat(den || 1)) || 30);
    } catch (e) {
      fps = 30; // fallback if ffprobe fails
    }
  } else {
    fps = Math.min(60, fps);
  }
  const threshold = clampInt(req.body.threshold,  0,  255, 128);
  const invert    = req.body.invert === 'true' || req.body.invert === true;
  const rotation  = parseFloat(req.body.rotation) || 0;
  const zoom      = parseFloat(req.body.zoom) || 1.0;
  const panX      = parseFloat(req.body.panX) || 0;
  const panY      = parseFloat(req.body.panY) || 0;

  // Use color mode if requested AND the environment supports it
  const isColor   = req.body.colorMode === 'true' && envConfig.isColor;
  
  // forSdCard: skip SPIFFS size limit and always use full resolution
  const forSdCard = req.body.forSdCard === 'true' && isColor;
  const skipFirmware = req.body.skipFirmware === 'true';

  let W = envConfig.width;
  let H = envConfig.height;

  createJob(jobId);
  updateJob(jobId, { chipFamily: chipInfo.chipFamily, bootloaderOffset: chipInfo.bootloaderOffset });
  res.status(202).json({ jobId });

  // Process in background so we don't block the HTTP response (firmware compile can take minutes)
  processJob(jobId, req.file.path, { env: displayEnv, fps, threshold, invert, isColor, forSdCard, skipFirmware, rotation, zoom, panX, panY, width: W, height: H }).catch((err) => {
    updateJob(jobId, { status: 'error', error: err.message });
  });
});

// Multer errors occur before the route callback. Delete a partial large upload
// immediately instead of leaving it on disk after a failed mobile upload.
router.use((err, req, res, next) => {
  if (!err) return next();
  if (req.jobId) {
    fs.rmSync(path.join(JOBS_ROOT, req.jobId), { recursive: true, force: true });
  }
  const message = err.code === 'LIMIT_FILE_SIZE'
    ? 'File is larger than the 2 GB upload limit.'
    : err.message || 'Upload failed.';
  res.status(400).json({ error: message });
});

router.delete('/clear', (req, res) => {
  try {
    const jobs = fs.readdirSync(JOBS_ROOT);
    let deletedCount = 0;
    for (const job of jobs) {
      const jobPath = path.join(JOBS_ROOT, job);
      if (fs.lstatSync(jobPath).isDirectory()) {
        fs.rmSync(jobPath, { recursive: true, force: true });
        deletedCount++;
      }
    }
    res.json({ success: true, deleted: deletedCount });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear jobs', details: err.message });
  }
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
        chipFamily: job.chipFamily,
        parts: [
          { path: `files/bootloader.bin`, offset: job.bootloaderOffset },
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

async function processJob(jobId, uploadedVideoPath, { env, fps, threshold, invert, isColor, forSdCard, skipFirmware, rotation, zoom, panX, panY, width: W, height: H }) {
  const jobDir      = path.join(JOBS_ROOT, jobId);
  const framesDir   = path.join(jobDir, 'frames');
  const videoDatPath = path.join(jobDir, 'video.dat');
  const outputDir   = path.join(jobDir, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const onLog = (chunk) => {
    // Command output arrives in arbitrary chunks; preserve readable lines and
    // omit empty carriage-return updates (such as ffmpeg's progress redraws).
    for (const line of String(chunk).split(/\r?\n|\r/)) {
      const trimmed = line.trim();
      if (trimmed) appendJobLog(jobId, trimmed);
    }
  };

  try {
  // Get duration once — used by both color and 1-bit paths to cap ffmpeg extraction
  updateJob(jobId, { status: 'extracting', progress: 'Reading video duration...' });
  let duration = 0;
  try {
    const out = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${uploadedVideoPath}"`);
    duration = parseFloat(out.toString().trim());
    if (Number.isNaN(duration)) duration = 0;
  } catch (e) {
    duration = 0;
  }

  const ext = path.extname(uploadedVideoPath).toLowerCase();
  const isImage = ['.jpg', '.jpeg', '.png', '.bmp', '.webp', '.gif'].includes(ext);

  if (isColor) {
    const totalFrames = Math.ceil(duration * fps);

    if (forSdCard) {
      // SD card has no size limit — always use full resolution
    } else {
      // Dynamically read the actual SPIFFS partition size from partitions.csv
      const MAX_SPIFFS_SIZE = getSpiffsMaxBytes();
      const HEADER_OVERHEAD = 16;         // packFramesColor header
      const PER_FRAME_LEN_PREFIX = 4;     // uint32 length prefix per frame

      if (totalFrames > 0) {
        const bytesPerPixel = 2; // RGB565
        let effectiveFps = fps;
        let fitted = false;

        // Helper: compute actual video.dat size including pack overhead
        const estimateSize = (w, h, nFrames) =>
          HEADER_OVERHEAD + nFrames * (PER_FRAME_LEN_PREFIX + w * h * bytesPerPixel);

        // First try: reduce FPS slightly (down to half) before sacrificing resolution
        for (let tryFps = fps; tryFps >= Math.max(1, Math.floor(fps / 2)); tryFps--) {
          const tryFrames = Math.ceil(duration * tryFps);
          if (tryFrames <= 0) continue;
          if (estimateSize(W, H, tryFrames) <= MAX_SPIFFS_SIZE) {
            effectiveFps = tryFps;
            fitted = true;
            if (tryFps !== fps) {
              updateJob(jobId, { progress: `Auto-reduced FPS: ${fps}→${tryFps} to fit SPIFFS.` });
            }
            break;
          }
        }

        // Second try: reduce resolution by scale factors
        if (!fitted) {
          const halfFps = Math.max(1, Math.floor(fps / 2));
          const tryFrames = Math.ceil(duration * halfFps);
          const SCALES = [2, 4, 5, 8, 10];
          for (const scale of SCALES) {
            const testW = Math.floor(W / scale);
            const testH = Math.floor(H / scale);
            if (estimateSize(testW, testH, tryFrames) <= MAX_SPIFFS_SIZE) {
              W = testW;
              H = testH;
              effectiveFps = halfFps;
              fitted = true;
              updateJob(jobId, { progress: `Auto-scaled to ${W}x${H} @${effectiveFps}fps to fit SPIFFS (${(MAX_SPIFFS_SIZE/1024).toFixed(0)}KB available).` });
              break;
            }
          }
        }

        if (!fitted) {
          throw new Error(`Video is ${duration.toFixed(1)}s long and cannot fit into SPIFFS (${(MAX_SPIFFS_SIZE/1024).toFixed(0)}KB). Use a shorter video, lower FPS, or enable SD Card mode.`);
        }

        fps = effectiveFps;
      }
    }

    updateJob(jobId, { status: 'extracting', progress: `Converting video to RGB565 raw (${W}x${H})...` });
    const rawFile = await extractFramesColor(uploadedVideoPath, framesDir, { fps, width: W, height: H, isImage, duration, rotation, zoom, panX, panY, onLog });

    updateJob(jobId, { status: 'packing', progress: `Packing color frames into video.dat...` });
    packFramesColor(rawFile, videoDatPath, { width: W, height: H, fps });
  } else {
    updateJob(jobId, { status: 'extracting', progress: 'Extracting frames from video with ffmpeg...' });
    const frames = await extractFrames(uploadedVideoPath, framesDir, { fps, width: W, height: H, isImage, duration, rotation, zoom, panX, panY, onLog });

    updateJob(jobId, { status: 'packing', progress: `RLE-encoding ${frames.length} frames...` });
    const { headerBytes, payloadBytes } = packFrames(frames, videoDatPath, { width: W, height: H, fps, threshold, invert });

    // RLE output size is data-dependent (depends on how much each frame
    // changes/contrasts), so it can't be predicted before encoding the way
    // the raw RGB565 color path can. Check AFTER encoding instead, and fail
    // fast with an actionable message rather than letting `pio run -t
    // buildfs` crash later with a raw mkspiffs SPIFFS_write(-10001) error.
    const MAX_SPIFFS_SIZE = getSpiffsMaxBytes();
    const totalBytes = headerBytes + payloadBytes;
    if (totalBytes > MAX_SPIFFS_SIZE) {
      fs.rmSync(videoDatPath, { force: true });
      throw new Error(
        `Encoded video is ${(totalBytes / 1024).toFixed(0)}KB, which exceeds the SPIFFS partition ` +
        `(${(MAX_SPIFFS_SIZE / 1024).toFixed(0)}KB usable). Lower the FPS, raise the threshold ` +
        `contrast (fewer RLE run breaks), shorten the clip, or use a HAS_SD_CARD env with forSdCard.`
      );
    }
  }

  // Clean up temporary files to save disk space
  fs.rmSync(framesDir,           { recursive: true, force: true });
  fs.rmSync(uploadedVideoPath,   { force: true });

  if (!skipFirmware) {
    updateJob(jobId, { status: 'building', progress: 'Compiling firmware...' });
    const files = await compileFirmware({
      jobDir,
      env,
      videoDatPath,
      forSdCard,
      onProgress: (msg) => updateJob(jobId, { progress: msg }),
      onLog,
    });

    for (const [name, srcPath] of Object.entries(files)) {
      fs.copyFileSync(srcPath, path.join(outputDir, `${name}.bin`));
    }
  }

  updateJob(jobId, { status: 'done', progress: skipFirmware ? 'Done — video.dat ready' : 'Done — ready to flash' });
  } finally {
    // Always release the original upload and intermediate frames. This is
    // especially important for large phone videos when ffmpeg or PIO fails.
    fs.rmSync(framesDir, { recursive: true, force: true });
    fs.rmSync(uploadedVideoPath, { force: true });
  }
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

module.exports = router;

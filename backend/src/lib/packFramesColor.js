'use strict';

const fs = require('fs');
const path = require('path');
const { run } = require('./runCommand');

const HEADER_SIZE = 16;

async function extractFramesColor(videoPath, outDir, { fps, width, height, isImage, duration = 0 }) {
  fs.mkdirSync(outDir, { recursive: true });
  const rawFile = path.join(outDir, 'video_rgb565.raw');

  const scaleFilter =
    (isImage ? '' : `fps=${fps},`) +
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;

  const args = ['-y', '-i', videoPath];

  if (isImage) {
    args.push('-frames:v', '1');
  } else {
    if (duration > 0) args.push('-t', String(duration));
  }

  args.push('-vf', scaleFilter, '-pix_fmt', 'rgb565le', '-f', 'rawvideo', rawFile);

  await run('ffmpeg', args);

  if (!fs.existsSync(rawFile)) {
    throw new Error('ffmpeg produced no raw file. Verify the video file is valid.');
  }

  return rawFile;
}

function packFramesColor(rawFile, outPath, { width, height, fps }) {
  const bytesPerPixel = 2; // rgb565
  const frameBytes = width * height * bytesPerPixel;
  const stat = fs.statSync(rawFile);
  const frameCount = Math.floor(stat.size / frameBytes);

  const outFd = fs.openSync(outPath, 'w');
  const inFd = fs.openSync(rawFile, 'r');
  try {
    const header = Buffer.alloc(HEADER_SIZE);
    header.writeUInt16LE(width, 0);
    header.writeUInt16LE(height, 2);
    header.writeUInt32LE(frameCount, 4);
    header.writeUInt8(fps, 8);
    header.writeUInt8(2, 9); // colorMode = 2 (RGB565)
    fs.writeSync(outFd, header);

    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(frameBytes, 0);

    const buf = Buffer.alloc(frameBytes);
    for (let i = 0; i < frameCount; i++) {
      fs.readSync(inFd, buf, 0, frameBytes, null);
      fs.writeSync(outFd, lenBuf);
      fs.writeSync(outFd, buf);
    }
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(inFd);
  }
}

module.exports = { extractFramesColor, packFramesColor };

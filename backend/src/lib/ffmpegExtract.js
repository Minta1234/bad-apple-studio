'use strict';

const fs = require('fs');
const path = require('path');
const { run } = require('./runCommand');

// แตกวิดีโอเป็นเฟรม grayscale 8-bit (.pgm) ที่ resize + letterbox ให้พอดี width x height
// ใช้ pad สีดำ (ไม่ crop) เพื่อไม่ให้ภาพเพี้ยนอัตราส่วน
async function extractFrames(videoPath, outDir, { fps, width, height }) {
  fs.mkdirSync(outDir, { recursive: true });

  const filter =
    `fps=${fps},` +
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,` +
    `format=gray`;

  await run('ffmpeg', [
    '-y',
    '-i', videoPath,
    '-vf', filter,
    '-f', 'image2',
    path.join(outDir, 'frame_%06d.pgm'),
  ]);

  const frames = fs.readdirSync(outDir)
    .filter((f) => f.endsWith('.pgm'))
    .sort();

  if (frames.length === 0) {
    throw new Error('ffmpeg ไม่สร้างเฟรมออกมาเลย ตรวจว่าไฟล์วิดีโอเปิดได้จริง');
  }

  return frames.map((f) => path.join(outDir, f));
}

module.exports = { extractFrames };

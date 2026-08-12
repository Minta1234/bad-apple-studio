'use strict';

const fs = require('fs');
const path = require('path');
const { run } = require('./runCommand');

// Extract video as 8-bit grayscale frames (.pgm), resized + letterboxed to fit width x height
// Uses black padding (no crop) to preserve aspect ratio
async function extractFrames(videoPath, outDir, { fps, width, height, isImage, duration = 0 }) {
  fs.mkdirSync(outDir, { recursive: true });

  const filter =
    (isImage ? '' : `fps=${fps},`) +
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,` +
    `format=gray`;

  const args = ['-y', '-i', videoPath];

  if (isImage) {
    // For static images: extract exactly 1 frame, no fps filter needed
    args.push('-frames:v', '1');
  } else {
    // For videos/GIFs: cap duration to prevent animated GIFs from looping forever
    if (duration > 0) args.push('-t', String(duration));
  }

  args.push('-vf', filter, '-f', 'image2', path.join(outDir, 'frame_%06d.pgm'));

  await run('ffmpeg', args);

  const frames = fs.readdirSync(outDir)
    .filter((f) => f.endsWith('.pgm'))
    .sort();

  if (frames.length === 0) {
    throw new Error('ffmpeg produced no frames. Verify the video file is valid.');
  }

  return frames.map((f) => path.join(outDir, f));
}

module.exports = { extractFrames };

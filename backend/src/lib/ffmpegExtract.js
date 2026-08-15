'use strict';

const fs = require('fs');
const path = require('path');
const { run } = require('./runCommand');

// Build FFmpeg filter chain for free rotation, zoom, and pan
function buildTransformFilter(width, height, zoom = 1.0, panX = 0, panY = 0, rotation = 0) {
  // 1. Scale video to fit within width/height (decrease), then multiply by zoom
  const scale = `scale='iw*min(${width}/iw\\,${height}/ih)*${zoom}':'ih*min(${width}/iw\\,${height}/ih)*${zoom}'`;
  
  // 2. Pad to a large virtual canvas to prevent clipping during rotation and heavy panning
  const padW = `max(iw\\,${width}*4)`;
  const padH = `max(ih\\,${height}*4)`;
  const pad = `pad=${padW}:${padH}:(ow-iw)/2:(oh-ih)/2:color=black`;
  
  // 3. Rotate around the center
  const rot = `rotate=a=${rotation}*PI/180:ow=iw:oh=ih:c=black`;
  
  // 4. Crop the final display window
  // Center is iw/2, ih/2. Panning moves the image, so crop window moves inversely.
  const cx = `(iw-${width})/2 - ${panX}`;
  const cy = `(ih-${height})/2 - ${panY}`;
  const crop = `crop=${width}:${height}:${cx}:${cy}`;
  
  return `${scale},${pad},${rot},${crop}`;
}

// Extract video as 8-bit grayscale frames (.pgm), resized + letterboxed to fit width x height
async function extractFrames(videoPath, outDir, { fps, width, height, isImage, duration = 0, rotation = 0, zoom = 1.0, panX = 0, panY = 0 }) {
  fs.mkdirSync(outDir, { recursive: true });

  const transform = buildTransformFilter(width, height, zoom, panX, panY, rotation);
  const filter =
    (isImage ? '' : `fps=${fps},`) +
    transform +
    `,format=gray`;

  const args = ['-y', '-i', videoPath];

  if (isImage) {
    args.push('-frames:v', '1');
  } else {
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

module.exports = { extractFrames, buildTransformFilter };

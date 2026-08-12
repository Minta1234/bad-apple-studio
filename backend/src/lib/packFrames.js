'use strict';

const fs = require('fs');

const HEADER_SIZE = 16; // must match struct VideoHeader in firmware/src/main.cpp

// Minimal PGM (P5, binary grayscale) parser — sufficient for ffmpeg output
// Does not support comments mid-header (ffmpeg doesn't emit them, but handles edge cases lightly)
function parsePGM(buf) {
  let pos = 0;
  const readToken = () => {
    while (buf[pos] === 0x23) { // '#' comment line -> skip entire line
      while (buf[pos] !== 0x0a) pos++;
      pos++;
    }
    while (/\s/.test(String.fromCharCode(buf[pos]))) pos++;
    let start = pos;
    while (pos < buf.length && !/\s/.test(String.fromCharCode(buf[pos]))) pos++;
    return buf.toString('ascii', start, pos);
  };

  const magic = readToken();
  if (magic !== 'P5') throw new Error(`Frame file is not PGM P5 (got ${magic})`);;
  const width = parseInt(readToken(), 10);
  const height = parseInt(readToken(), 10);
  const maxval = parseInt(readToken(), 10);
  
  if (buf[pos] === 0x0D && buf[pos + 1] === 0x0A) {
    pos += 2; // Windows CRLF
  } else {
    pos += 1; // single whitespace byte (e.g. \n) before binary data per PGM spec
  }

  const data = buf.subarray(pos, pos + width * height);
  return { width, height, maxval, data };
}

// Encode a varint in LEB128 format (7 bits per byte, MSB=continuation) — must match
// readVarint() on the firmware side
function encodeVarint(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

// Convert a grayscale frame to a run-length sequence of bits (0/1) in row-major order using threshold.
// invert=true flips black/white in case the source video is inverted relative to what's needed.
function rleEncodeFrame(gray, width, height, threshold, invert) {
  const total = width * height;
  const runs = [];
  // Convention: the first run is always the length of color "0" (off).
  // If the frame starts with color 1 immediately, the loop pushes(0) automatically on the first mismatch.
  // (Do NOT add a special-case before the loop — that would produce a duplicate zero-length run.)
  let runLen = 0;
  let lastColor = 0;
  for (let i = 0; i < total; i++) {
    let px = (gray[i] >= threshold) ? 1 : 0;
    if (invert) px ^= 1;
    if (px === lastColor) {
      runLen++;
    } else {
      runs.push(runLen);
      lastColor = px;
      runLen = 1;
    }
  }
  runs.push(runLen);

  return Buffer.concat(runs.map(encodeVarint));
}

// Read all .pgm frames, threshold + RLE encode, and write to a single video.dat file.
// Format: [header 16 bytes][ (uint32 len + RLE bytes) x frameCount ]
function packFrames(framePaths, outPath, { width, height, fps, threshold, invert }) {
  const fd = fs.openSync(outPath, 'w');
  try {
    const header = Buffer.alloc(HEADER_SIZE);
    header.writeUInt16LE(width, 0);
    header.writeUInt16LE(height, 2);
    header.writeUInt32LE(framePaths.length, 4);
    header.writeUInt8(fps, 8);
    fs.writeSync(fd, header);

    let totalPayloadBytes = 0;
    for (const framePath of framePaths) {
      const raw = fs.readFileSync(framePath);
      const { width: w, height: h, data } = parsePGM(raw);
      if (w !== width || h !== height) {
        throw new Error(`Frame ${framePath} is ${w}x${h} but expected ${width}x${height}`);
      }
      const encoded = rleEncodeFrame(data, width, height, threshold, invert);

      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32LE(encoded.length, 0);
      fs.writeSync(fd, lenBuf);
      fs.writeSync(fd, encoded);
      totalPayloadBytes += 4 + encoded.length;
    }

    return { headerBytes: HEADER_SIZE, payloadBytes: totalPayloadBytes };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { packFrames, parsePGM, rleEncodeFrame, encodeVarint };

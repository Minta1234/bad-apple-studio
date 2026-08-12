'use strict';

const fs = require('fs');

const HEADER_SIZE = 16; // ต้องตรงกับ struct VideoHeader ใน firmware/src/main.cpp

// พาร์ส PGM (P5, binary grayscale) แบบ minimal — พอสำหรับ output ของ ffmpeg
// ไม่รองรับ comment กลาง header เพราะ ffmpeg ไม่ใส่ แต่กัน edge case เผื่อไว้เล็กน้อย
function parsePGM(buf) {
  let pos = 0;
  const readToken = () => {
    while (buf[pos] === 0x23) { // '#' comment line -> ข้ามทั้งบรรทัด
      while (buf[pos] !== 0x0a) pos++;
      pos++;
    }
    while (/\s/.test(String.fromCharCode(buf[pos]))) pos++;
    let start = pos;
    while (pos < buf.length && !/\s/.test(String.fromCharCode(buf[pos]))) pos++;
    return buf.toString('ascii', start, pos);
  };

  const magic = readToken();
  if (magic !== 'P5') throw new Error(`ไฟล์เฟรมไม่ใช่ PGM P5 (ได้ ${magic})`);
  const width = parseInt(readToken(), 10);
  const height = parseInt(readToken(), 10);
  const maxval = parseInt(readToken(), 10);
  pos += 1; // whitespace byte เดี่ยวคั่นก่อน binary data ตามสเปก PGM

  const data = buf.subarray(pos, pos + width * height);
  return { width, height, maxval, data };
}

// เข้ารหัส varint แบบ LEB128 (7 bit ต่อไบต์, MSB=continuation) — ต้องตรงกับ
// readVarint() ฝั่ง firmware
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

// แปลงเฟรม grayscale เป็น run-length ของ bit (0/1) แบบ row-major ตาม threshold
// invert=true กลับขาว/ดำ เผื่อวิดีโอ source ตรงข้ามกับที่ต้องการ
function rleEncodeFrame(gray, width, height, threshold, invert) {
  const total = width * height;
  const runs = [];
  // convention: run แรกเสมอเป็นความยาวของสี "0" (off) ต่อเนื่อง — ถ้าเฟรมเริ่มด้วย
  // สี 1 ทันที ตัว loop ด้านล่างจะ push(0) เองโดยอัตโนมัติตอนเจอ mismatch แรก
  // (ห้ามเพิ่ม special-case ก่อน loop ซ้ำ จะได้ run ความยาว 0 ซ้ำสองครั้ง)
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

// อ่านเฟรม .pgm ทั้งหมด, threshold + RLE, เขียนเป็นไฟล์เดียว video.dat
// รูปแบบ: [header 16 bytes][ (uint32 len + RLE bytes) x frameCount ]
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
        throw new Error(`เฟรม ${framePath} ขนาด ${w}x${h} ไม่ตรงกับที่ตั้งไว้ ${width}x${height}`);
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

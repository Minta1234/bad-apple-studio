// Bad Apple OLED player — ESP32 + SSD1306(0.96") หรือ SH1106(1.3")
// อ่านเฟรมที่เข้ารหัส RLE จาก /video.dat บน SPIFFS แล้วเล่นแบบ non-blocking
// (ไม่มี delay() บล็อกใน loop — ใช้ millis() diff ตาม pattern มาตรฐานงาน embedded)

#include <Arduino.h>
#include <SPIFFS.h>
#include <U8g2lib.h>
#include <Wire.h>

#if defined(DISPLAY_DRIVER_SSD1306)
  U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, /* reset=*/ U8X8_PIN_NONE);
#elif defined(DISPLAY_DRIVER_SH1106)
  U8G2_SH1106_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, /* reset=*/ U8X8_PIN_NONE);
#else
  #error "ต้อง define DISPLAY_DRIVER_SSD1306 หรือ DISPLAY_DRIVER_SH1106 ผ่าน build_flags"
#endif

static const uint16_t FRAME_W = DISPLAY_W;   // 128
static const uint16_t FRAME_H = DISPLAY_H;   // 64
static const size_t   FRAME_BYTES = (FRAME_W * FRAME_H) / 8; // 1024

struct VideoHeader {
  uint16_t width;
  uint16_t height;
  uint32_t frameCount;
  uint8_t  fps;
  uint8_t  reserved[7];
};

static File videoFile;
static VideoHeader header;
static uint32_t headerEndOffset = 0;
static uint32_t frameIntervalMs = 66; // fallback ~15fps ถ้า header อ่านพลาด
static uint32_t lastFrameAt = 0;

static uint8_t frameBuf[FRAME_BYTES];

// อ่าน varint แบบ LEB128 (continuation bit = 0x80) จาก buffer, คืนค่า runLength
// และขยับ index เดินหน้าไปตามจำนวนไบต์ที่ใช้จริง
static uint32_t readVarint(const uint8_t* data, size_t len, size_t& idx) {
  uint32_t result = 0;
  int shift = 0;
  while (idx < len) {
    uint8_t b = data[idx++];
    result |= (uint32_t)(b & 0x7F) << shift;
    if ((b & 0x80) == 0) break;
    shift += 7;
  }
  return result;
}

// ถอดรหัส run-length ทีละเฟรมจาก payload ลง frameBuf (bit-packed, LSB-first,
// row-major, ตรงกับ layout ที่ backend/src/lib/packFrames.js เขียนไว้)
static void decodeFrame(const uint8_t* payload, size_t payloadLen) {
  memset(frameBuf, 0, FRAME_BYTES);
  size_t idx = 0;
  uint32_t bitPos = 0;
  uint8_t color = 0; // เริ่มด้วยสีที่ไม่ติด (0) เสมอ ตาม convention ฝั่ง encoder
  const uint32_t totalBits = (uint32_t)FRAME_W * FRAME_H;

  while (idx < payloadLen && bitPos < totalBits) {
    uint32_t run = readVarint(payload, payloadLen, idx);
    if (color) {
      for (uint32_t i = 0; i < run && bitPos < totalBits; i++, bitPos++) {
        frameBuf[bitPos >> 3] |= (1 << (bitPos & 7));
      }
    } else {
      bitPos += run;
    }
    color ^= 1;
  }
}

static bool readNextFrame() {
  if (!videoFile || !videoFile.available()) {
    // จบไฟล์ -> วนกลับไปเฟรมแรก (ต่อจาก header)
    if (!videoFile.seek(headerEndOffset)) return false;
  }

  uint32_t frameLen = 0;
  if (videoFile.read((uint8_t*)&frameLen, sizeof(frameLen)) != sizeof(frameLen)) {
    return false;
  }
  if (frameLen == 0 || frameLen > 8192) {
    // กันไฟล์เพี้ยน/อ่านหลุด offset ไม่ให้ malloc มั่ว
    return false;
  }

  static uint8_t payload[8192];
  size_t got = videoFile.read(payload, frameLen);
  if (got != frameLen) return false;

  decodeFrame(payload, frameLen);
  return true;
}

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22); // SDA, SCL — แก้ตรงนี้ถ้าบอร์ดต่อขาอื่น
  u8g2.begin();
  u8g2.setBusClock(400000);

  if (!SPIFFS.begin(true)) {
    Serial.println("SPIFFS mount ล้มเหลว");
    return;
  }

  videoFile = SPIFFS.open("/video.dat", "r");
  if (!videoFile) {
    Serial.println("เปิด /video.dat ไม่ได้");
    return;
  }

  if (videoFile.read((uint8_t*)&header, sizeof(header)) != sizeof(header)) {
    Serial.println("อ่าน header ไม่ครบ");
    return;
  }
  headerEndOffset = sizeof(header);

  if (header.fps > 0) {
    frameIntervalMs = 1000UL / header.fps;
  }

  Serial.printf("วิดีโอ %ux%u, %u เฟรม, %u fps\n",
                header.width, header.height, header.frameCount, header.fps);

  lastFrameAt = millis();
}

void loop() {
  uint32_t now = millis();
  if (now - lastFrameAt < frameIntervalMs) {
    return; // ยังไม่ถึงเวลาเฟรมถัดไป — ไม่บล็อก, loop() วนกลับมาเช็คใหม่รอบหน้า
  }
  lastFrameAt += frameIntervalMs; // กันสะสม drift ถ้าเฟรมก่อนใช้เวลาถอดรหัสนานผิดปกติ

  if (!readNextFrame()) {
    return; // ข้ามเฟรมนี้ถ้าอ่าน/ถอดรหัสพลาด แทนที่จะค้าง
  }

  u8g2.clearBuffer();
  u8g2.drawXBM(0, 0, FRAME_W, FRAME_H, frameBuf);
  u8g2.sendBuffer();
}

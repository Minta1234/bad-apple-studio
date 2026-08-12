// Bad Apple player — ESP32
// Supports: SSD1306 (I2C), SH1106 (I2C), ILI9341 SPI (ESP32-2432S028)
// Reads RLE frames from /video.dat on SPIFFS and plays them non-blocking

#include <Arduino.h>
#include <SPIFFS.h>

// ── Display driver selection ──────────────────────────────────────────────────
#if defined(DISPLAY_DRIVER_ILI9341)
  #include <TFT_eSPI.h>
  #include <SD.h>
  #include <SPI.h>
  static TFT_eSPI tft;


#elif defined(DISPLAY_DRIVER_SSD1306)
  #include <U8g2lib.h>
  #include <Wire.h>
  static U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);

#elif defined(DISPLAY_DRIVER_SH1106)
  #include <U8g2lib.h>
  #include <Wire.h>
  static U8G2_SH1106_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);

#else
  #error "Define DISPLAY_DRIVER_SSD1306, DISPLAY_DRIVER_SH1106, or DISPLAY_DRIVER_ILI9341"
#endif

// ── Frame geometry ────────────────────────────────────────────────────────────
static const uint16_t FRAME_W     = DISPLAY_W;
static const uint16_t FRAME_H     = DISPLAY_H;
static const uint32_t FRAME_BITS  = (uint32_t)FRAME_W * FRAME_H;
static const size_t   FRAME_BYTES = FRAME_BITS / 8;

// ── Video file header (must match backend/src/lib/packFrames.js) ──────────────
struct VideoHeader {
  uint16_t width;
  uint16_t height;
  uint32_t frameCount;
  uint8_t  fps;
  uint8_t  colorMode; // 0 = 1-bit RLE, 2 = RGB565 raw
  uint8_t  reserved[6];
};

static File       videoFile;
static VideoHeader header;
static uint32_t   headerEndOffset = 0;
static uint32_t   frameIntervalMs = 66;
static uint32_t   lastFrameAt     = 0;

// Frame buffers (static — live in BSS, not stack)
static uint8_t frameBuf[FRAME_BYTES];            // 1-bit packed, LSB-first
static uint8_t payload[(FRAME_W * FRAME_H) + 16]; // worst-case RLE payload + safety margin

// ── Varint (LEB128) decoder ───────────────────────────────────────────────────
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

// ── RLE decoder → frameBuf ────────────────────────────────────────────────────
static void decodeFrame(const uint8_t* pl, size_t plLen) {
  memset(frameBuf, 0, FRAME_BYTES);
  size_t   idx    = 0;
  uint32_t bitPos = 0;
  uint8_t  color  = 0;

  while (idx < plLen && bitPos < FRAME_BITS) {
    uint32_t run = readVarint(pl, plLen, idx);
    if (color) {
      for (uint32_t i = 0; i < run && bitPos < FRAME_BITS; i++, bitPos++)
        frameBuf[bitPos >> 3] |= (1 << (bitPos & 7));
    } else {
      bitPos += run;
    }
    color ^= 1;
  }
}

// ── Read next RLE frame from SPIFFS (1-bit) ───────────────────────────────────
static bool readNextFrame1Bit() {
  // If single-frame (static image), only seek back if we haven't drawn it yet
  if (!videoFile.available()) {
    if (header.frameCount <= 1) return false; // freeze: don't loop
    if (!videoFile.seek(headerEndOffset)) return false;
  }

  uint32_t frameLen = 0;
  if (videoFile.read((uint8_t*)&frameLen, 4) != 4) return false;
  if (frameLen == 0 || frameLen > sizeof(payload))   return false;

  if (videoFile.read(payload, frameLen) != frameLen) return false;
  decodeFrame(payload, frameLen);
  return true;
}

// ── Read and Render RGB565 frame directly to TFT ──────────────────────────────
static bool readAndRenderColorFrame() {
  if (!videoFile.available()) {
    if (header.frameCount <= 1) return false; // freeze: don't loop single images
    if (!videoFile.seek(headerEndOffset)) return false;
  }

  uint32_t frameLen = 0;
  if (videoFile.read((uint8_t*)&frameLen, 4) != 4) return false;

  uint16_t frameW = header.width;
  uint16_t frameH = header.height;

  // Expected length is width * height * 2
  if (frameLen != (uint32_t)frameW * frameH * 2) {
    videoFile.seek(videoFile.position() + frameLen);
    return true; // Skip invalid frames
  }

#if defined(DISPLAY_DRIVER_ILI9341)
  uint8_t scale = DISPLAY_W / frameW;

  tft.startWrite();

  if (scale <= 1) {
    // Fast path: No scaling needed (fills screen or is larger)
    uint16_t xOffset = (DISPLAY_W > frameW) ? (DISPLAY_W - frameW) / 2 : 0;
    uint16_t yOffset = (DISPLAY_H > frameH) ? (DISPLAY_H - frameH) / 2 : 0;
    tft.setAddrWindow(xOffset, yOffset, frameW, frameH);

    const int linesPerChunk = 10;
    const int bytesPerChunk = 320 * 2 * linesPerChunk; // fixed max size
    static uint8_t chunkBuf[320 * 2 * 10]; // static: avoid stack overflow (6400 bytes)

    int bytesRemaining = frameLen;
    while (bytesRemaining > 0) {
      int toRead = (bytesRemaining < bytesPerChunk) ? bytesRemaining : bytesPerChunk;
      int bytesRead = videoFile.read(chunkBuf, toRead);
      if (bytesRead <= 0) break;
      tft.pushColors((uint16_t*)chunkBuf, bytesRead / 2, true);
      bytesRemaining -= bytesRead;
    }
  } else {
    // Upscale path: Scale integer times to fill the screen
    tft.setAddrWindow(0, 0, DISPLAY_W, DISPLAY_H);
    
    const int bytesPerRow = frameW * 2;
    static uint8_t rowBuf[320 * 2];      // static: avoid stack overflow
    static uint16_t upscaledRow[DISPLAY_W]; // static: avoid stack overflow
    
    for (uint16_t y = 0; y < frameH; y++) {
      if (videoFile.read(rowBuf, bytesPerRow) != bytesPerRow) break;
      
      uint16_t* pixels = (uint16_t*)rowBuf;
      int outIdx = 0;
      
      // Duplicate pixels horizontally
      for (uint16_t x = 0; x < frameW; x++) {
        uint16_t p = pixels[x];
        for (uint8_t s = 0; s < scale; s++) {
          upscaledRow[outIdx++] = p;
        }
      }
      
      // Push the duplicated line vertically 'scale' times
      for (uint8_t s = 0; s < scale; s++) {
        tft.pushColors(upscaledRow, DISPLAY_W, true);
      }
    }
  }
  
  tft.endWrite();
#else
  // Skip if display doesn't support color
  videoFile.seek(videoFile.position() + frameLen);
#endif

  return true;
}

// ── Render frameBuf to display (for 1-bit mode) ───────────────────────────────
static void renderFrame1Bit() {
#if defined(DISPLAY_DRIVER_ILI9341)
  static uint16_t lineBuf[FRAME_W];
  tft.startWrite();
  tft.setAddrWindow(0, 0, FRAME_W, FRAME_H);
  for (uint16_t y = 0; y < FRAME_H; y++) {
    for (uint16_t x = 0; x < FRAME_W; x++) {
      uint32_t bitPos = (uint32_t)y * FRAME_W + x;
      lineBuf[x] = (frameBuf[bitPos >> 3] >> (bitPos & 7)) & 1 ? 0xFFFF : 0x0000;
    }
    tft.pushColors(lineBuf, FRAME_W, true);
  }
  tft.endWrite();

#else
  u8g2.clearBuffer();
  u8g2.drawXBM(0, 0, FRAME_W, FRAME_H, frameBuf);
  u8g2.sendBuffer();
#endif
}

// ── setup ─────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);

#if defined(DISPLAY_DRIVER_ILI9341)
  tft.init();
  tft.setRotation(1);        // landscape 320x240
  tft.fillScreen(TFT_BLACK);
  #ifdef TFT_BL
    pinMode(TFT_BL, OUTPUT);
    digitalWrite(TFT_BL, HIGH); // backlight on
  #endif
#else
  Wire.begin(21, 22);        // SDA, SCL — change pins if your board uses different ones
  u8g2.begin();
  u8g2.setBusClock(400000);
#endif

  bool videoOpened = false;

#if defined(DISPLAY_DRIVER_ILI9341)
  // The CYD board has a MicroSD card slot. Try to mount it first!
  // CYD standard SD pins: CS=5, SCK=18, MISO=19, MOSI=23 (VSPI)
  // The Touchscreen also shares this VSPI bus (CS=33). We MUST pull the touch CS 
  // high so it doesn't interfere with the SD card on the MISO line.
  
  pinMode(33, OUTPUT);
  digitalWrite(33, HIGH); // Disable Touchscreen SPI

  pinMode(5, OUTPUT);
  digitalWrite(5, HIGH); // Ensure SD CS is pulled high before init
  delay(100);            // Give the SD card a moment to power up

  static SPIClass sdSPI(VSPI);
  sdSPI.begin(18, 19, 23, 5); // SCK, MISO, MOSI, SS
  
  // Try to mount at 4MHz (very safe/slow speed) to avoid 'cmd: 0x00' errors
  if (SD.begin(5, sdSPI, 4000000)) {
    videoFile = SD.open("/video.dat", "r");
    if (videoFile) {
      Serial.println("Found /video.dat on SD Card!");
      videoOpened = true;
    } else {
      Serial.println("No /video.dat on SD Card. Falling back to SPIFFS...");
    }
  } else {
    Serial.println("SD Card mount failed or not present. Falling back to SPIFFS...");
  }
#endif

  if (!videoOpened) {
    if (!SPIFFS.begin(true)) {
      Serial.println("SPIFFS mount failed"); return;
    }

    videoFile = SPIFFS.open("/video.dat", "r");
    if (!videoFile) {
      Serial.println("Cannot open /video.dat"); return;
    }
    Serial.println("Opened /video.dat from SPIFFS");
  }

  if (videoFile.read((uint8_t*)&header, sizeof(header)) != sizeof(header)) {
    Serial.println("Header read failed"); return;
  }
  headerEndOffset = sizeof(header);

  if (header.fps > 0) frameIntervalMs = 1000UL / header.fps;

  Serial.printf("Video %ux%u, %u frames, %u fps\n",
                header.width, header.height, header.frameCount, header.fps);

  lastFrameAt = millis();
}

// ── loop ──────────────────────────────────────────────────────────────────────
void loop() {
  uint32_t now = millis();
  if (now - lastFrameAt < frameIntervalMs) return;
  lastFrameAt += frameIntervalMs;

  if (header.colorMode == 2) {
    readAndRenderColorFrame();
  } else {
    if (!readNextFrame1Bit()) return;
    renderFrame1Bit();
  }
}

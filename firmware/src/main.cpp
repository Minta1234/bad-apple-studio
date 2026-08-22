// Bad Apple player — ESP32
// Supports: SSD1306 (I2C), SH1106 (I2C), ILI9341 SPI (ESP32-2432S028)
// Reads RLE frames from /video.dat on SPIFFS and plays them non-blocking

#include <Arduino.h>
#include <SPIFFS.h>
#ifdef HAS_BLE
#include "BleServer.h"
#endif

// ── Display driver selection ──────────────────────────────────────────────────
#if defined(DISPLAY_DRIVER_TFT) || defined(DISPLAY_DRIVER_ILI9341) || defined(DISPLAY_DRIVER_ST7789)
  #include <TFT_eSPI.h>
  #include <SPI.h>
  #ifdef HAS_SD_CARD
    #include <SD.h>
  #endif
  static TFT_eSPI tft;


#elif defined(DISPLAY_DRIVER_SSD1306)
  #include <U8g2lib.h>
  #include <Wire.h>
  static U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);

#elif defined(DISPLAY_DRIVER_SH1106)
  #include <U8g2lib.h>
  #include <Wire.h>
  static U8G2_SH1106_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);

#elif defined(DISPLAY_DRIVER_U8G2_CUSTOM)
  // Custom U8g2 class — user supplies the class name via U8G2_CLASS build flag
  // e.g. -DU8G2_CLASS=U8G2_SSD1309_128X64_NONAME0_F_HW_I2C
  #include <U8g2lib.h>
  #include <Wire.h>
  #ifndef U8G2_CLASS
    #error "U8G2_CLASS must be defined when using DISPLAY_DRIVER_U8G2_CUSTOM"
  #endif
  static U8G2_CLASS u8g2(U8G2_R0, U8X8_PIN_NONE);

#elif defined(DISPLAY_DRIVER_ARDUINO_GFX)
  #include <Arduino_GFX_Library.h>
  #ifdef HAS_SD_CARD
    #include <SD.h>
  #endif
  
  #if defined(GFX_PANEL_4827S043)
    Arduino_ESP32RGBPanel *rgbpanel = new Arduino_ESP32RGBPanel(
      40, 41, 39, 42,
      45, 48, 47, 21, 14,
      5, 6, 7, 15, 16, 4,
      8, 3, 46, 9, 1,
      0, 1, 1, 43,
      0, 3, 1, 12);
    Arduino_RGB_Display *gfx = new Arduino_RGB_Display(480, 272, rgbpanel, 0, true);
  #elif defined(GFX_PANEL_8048S043) || defined(GFX_PANEL_8048S070)
    Arduino_ESP32RGBPanel *rgbpanel = new Arduino_ESP32RGBPanel(
      40, 41, 39, 42,
      14, 21, 47, 48, 45,
      9, 46, 3, 8, 16, 1,
      15, 7, 6, 5, 4,
      0, 30, 4, 16,
      0, 13, 4, 12);
    Arduino_RGB_Display *gfx = new Arduino_RGB_Display(800, 480, rgbpanel, 0, true);
  #else
    #error "Unknown RGB panel"
  #endif

#else
  #error "Define DISPLAY_DRIVER_SSD1306, DISPLAY_DRIVER_SH1106, DISPLAY_DRIVER_U8G2_CUSTOM, DISPLAY_DRIVER_TFT, or DISPLAY_DRIVER_ARDUINO_GFX"
#endif

#ifndef I2C_SDA
  #define I2C_SDA 21
#endif
#ifndef I2C_SCL
  #define I2C_SCL 22
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

File       videoFile;
bool       isReceivingVideo = false;

static VideoHeader header;
static uint32_t   headerEndOffset = 0;
static uint32_t   frameIntervalMs = 66;
static uint32_t   lastFrameAt     = 0;

// Which filesystem /video.dat currently lives on — set at boot and again after
// every successful BLE upload, so playback and reloadVideo() always agree.
static bool videoOnSD = false;

void reloadVideo() {
  if (videoFile) videoFile.close();
#ifdef HAS_SD_CARD
  videoFile = videoOnSD ? SD.open("/video.dat", "r") : SPIFFS.open("/video.dat", "r");
#else
  videoFile = SPIFFS.open("/video.dat", "r");
#endif
  if (videoFile && videoFile.read((uint8_t*)&header, sizeof(header)) == sizeof(header)) {
    headerEndOffset = sizeof(header);
    if (header.fps > 0) frameIntervalMs = 1000UL / header.fps;
    Serial.printf("Reloaded Video: %ux%u, %u frames, %u fps (source=%s)\n",
                  header.width, header.height, header.frameCount, header.fps,
                  videoOnSD ? "SD" : "SPIFFS");
  } else {
    Serial.println("Failed to reload video header.");
  }
}

// ── BLE upload — storage selection ────────────────────────────────────────────
// The board's onboard SPIFFS partition is small (see partitions.csv). A large,
// full-quality video won't fit — in that case we need a microSD card to catch
// the overflow instead of failing a write partway through. Reserve headroom on
// both targets so we never fill a filesystem to the very last byte (SPIFFS in
// particular gets unreliable near 100% full).
static const uint32_t SPIFFS_RESERVE_BYTES = 32UL * 1024;

#ifdef HAS_SD_CARD
static const uint32_t SD_RESERVE_BYTES = 64UL * 1024;

#ifndef SD_SCK
#define SD_SCK 18
#define SD_MISO 19
#define SD_MOSI 23
#define SD_CS 5
#endif

#if CONFIG_IDF_TARGET_ESP32S3 || CONFIG_IDF_TARGET_ESP32S2 || CONFIG_IDF_TARGET_ESP32C3
static SPIClass sdSPI(FSPI);
#else
static SPIClass sdSPI(VSPI);
#endif

static bool     sdMounted = false;

static bool ensureSDMounted() {
  if (sdMounted) return true;
  // Touch CS must be held high or it will jam SD's MISO line on 2.8" CYD.
#ifndef CONFIG_IDF_TARGET_ESP32S3
  pinMode(33, OUTPUT);
  digitalWrite(33, HIGH);
#endif
  pinMode(SD_CS, OUTPUT);
  digitalWrite(SD_CS, HIGH);
  delay(50);
  sdSPI.begin(SD_SCK, SD_MISO, SD_MOSI, SD_CS);
  sdMounted = SD.begin(SD_CS, sdSPI, 4000000); // 4MHz: safe, avoids 'cmd:0x00' errors
  return sdMounted;
}
#endif

static uint32_t spiffsFreeBytes() {
  uint32_t total = SPIFFS.totalBytes();
  uint32_t used  = SPIFFS.usedBytes();
  return (total > used) ? (total - used) : 0;
}

#ifdef HAS_SD_CARD
static uint32_t sdFreeBytes() {
  if (!ensureSDMounted()) return 0;
  uint64_t total = SD.totalBytes();
  uint64_t used  = SD.usedBytes();
  return (total > used) ? (uint32_t)(total - used) : 0;
}
#endif

// Where the in-progress BLE upload is being written, and how far along it is.
enum class UploadTarget : uint8_t { NONE, SPIFFS_TARGET, SD_TARGET };
static UploadTarget uploadTarget       = UploadTarget::NONE;
uint32_t            expectedUploadBytes = 0;
uint32_t            receivedUploadBytes = 0;

// Called on BLE "START:<size>". Picks SPIFFS if the file fits within the
// onboard limit, otherwise falls back to the SD card. Returns false (with no
// file opened) if neither target has room — the caller reports this upstream
// so the user knows to insert/replace the microSD card.
bool beginVideoReceive(uint32_t expectedBytes) {
  if (videoFile) videoFile.close();
  expectedUploadBytes = expectedBytes;
  receivedUploadBytes = 0;

  if ((uint64_t)expectedBytes + SPIFFS_RESERVE_BYTES <= spiffsFreeBytes()) {
    videoFile = SPIFFS.open("/video.dat", "w");
    if (!videoFile) { uploadTarget = UploadTarget::NONE; return false; }
    uploadTarget     = UploadTarget::SPIFFS_TARGET;
    isReceivingVideo = true;
    return true;
  }

#ifdef HAS_SD_CARD
  if ((uint64_t)expectedBytes + SD_RESERVE_BYTES <= sdFreeBytes()) {
    videoFile = SD.open("/video.dat", "w");
    if (!videoFile) { uploadTarget = UploadTarget::NONE; return false; }
    uploadTarget     = UploadTarget::SD_TARGET;
    isReceivingVideo = true;
    return true;
  }
#endif

  uploadTarget     = UploadTarget::NONE;
  isReceivingVideo = false;
  return false;
}

bool uploadTargetIsSD() { return uploadTarget == UploadTarget::SD_TARGET; }

// Called on BLE "END", or to discard a partial transfer (disconnect / write
// failure). Only swaps videoOnSD + reloads playback if the full byte count
// arrived intact — a truncated file is left on disk but never played, and
// the caller reports the mismatch upstream instead of silently looping stale
// or corrupt frames.
void endVideoReceive(bool aborted) {
  if (videoFile) videoFile.close();
  isReceivingVideo = false;
  if (!aborted && uploadTarget != UploadTarget::NONE && receivedUploadBytes == expectedUploadBytes) {
    videoOnSD = uploadTargetIsSD();
    reloadVideo();
  }
  uploadTarget = UploadTarget::NONE;
}


// Frame buffers — only needed for 1-bit (B&W) display modes.
// The CYD boards use RGB565 color mode exclusively, so skip these
// to free precious DRAM (needed by NimBLE stack).
#if defined(DISPLAY_DRIVER_SSD1306) || defined(DISPLAY_DRIVER_SH1106) || defined(DISPLAY_DRIVER_U8G2_CUSTOM)
static uint8_t frameBuf[FRAME_BYTES];            // 1-bit packed, LSB-first
static uint8_t payload[(FRAME_W * FRAME_H) + 16]; // worst-case RLE payload + safety margin
#endif

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

// ── RLE decoder → frameBuf (1-bit B&W displays only) ────────────────────────
#if defined(DISPLAY_DRIVER_SSD1306) || defined(DISPLAY_DRIVER_SH1106) || defined(DISPLAY_DRIVER_U8G2_CUSTOM)
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
#endif

// ── Read next RLE frame from SPIFFS (1-bit B&W displays only) ────────────────
#if defined(DISPLAY_DRIVER_SSD1306) || defined(DISPLAY_DRIVER_SH1106) || defined(DISPLAY_DRIVER_U8G2_CUSTOM)
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
#endif

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

#if defined(DISPLAY_DRIVER_TFT) || defined(DISPLAY_DRIVER_ILI9341) || defined(DISPLAY_DRIVER_ST7789) || defined(DISPLAY_DRIVER_ARDUINO_GFX)
  uint8_t scale = DISPLAY_W / frameW;

#if !defined(DISPLAY_DRIVER_ARDUINO_GFX)
  tft.startWrite();
#endif

  if (scale <= 1) {
    // Fast path: No scaling needed (fills screen or is larger)
    uint16_t xOffset = (DISPLAY_W > frameW) ? (DISPLAY_W - frameW) / 2 : 0;
    uint16_t yOffset = (DISPLAY_H > frameH) ? (DISPLAY_H - frameH) / 2 : 0;
    
#if !defined(DISPLAY_DRIVER_ARDUINO_GFX)
    tft.setAddrWindow(xOffset, yOffset, frameW, frameH);
#endif

    const int linesPerChunk = 10;
    const int bytesPerChunk = frameW * 2 * linesPerChunk;
    // max width 800 * 2 bytes * 10 lines = 16000 bytes
    static uint8_t chunkBuf[16000]; 

    int bytesRemaining = frameLen;
    int currentY = 0;
    while (bytesRemaining > 0) {
      int toRead = (bytesRemaining < bytesPerChunk) ? bytesRemaining : bytesPerChunk;
      int bytesRead = videoFile.read(chunkBuf, toRead);
      if (bytesRead <= 0) break;
      
#if defined(DISPLAY_DRIVER_ARDUINO_GFX)
      int linesRead = bytesRead / (frameW * 2);
      gfx->draw16bitRGBBitmap(xOffset, yOffset + currentY, (uint16_t*)chunkBuf, frameW, linesRead);
      currentY += linesRead;
#else
      tft.pushColors((uint16_t*)chunkBuf, bytesRead / 2, true);
#endif
      bytesRemaining -= bytesRead;
    }
  } else {
    // Upscale path: Scale integer times to fill the screen
#if !defined(DISPLAY_DRIVER_ARDUINO_GFX)
    tft.setAddrWindow(0, 0, DISPLAY_W, DISPLAY_H);
#endif
    
    const int bytesPerRow = frameW * 2;
    static uint8_t rowBuf[1600];      // max frameW ~800 * 2
    static uint16_t upscaledRow[800]; // max DISPLAY_W 800
    
    int currentY = 0;
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
#if defined(DISPLAY_DRIVER_ARDUINO_GFX)
        gfx->draw16bitRGBBitmap(0, currentY++, upscaledRow, DISPLAY_W, 1);
#else
        tft.pushColors(upscaledRow, DISPLAY_W, true);
#endif
      }
    }
  }
  
#if !defined(DISPLAY_DRIVER_ARDUINO_GFX)
  tft.endWrite();
#endif
#else
  // Skip if display doesn't support color
  videoFile.seek(videoFile.position() + frameLen);
#endif

  return true;
}

// ── Render frameBuf to display (for 1-bit mode) ───────────────────────────────
#if defined(DISPLAY_DRIVER_SSD1306) || defined(DISPLAY_DRIVER_SH1106) || defined(DISPLAY_DRIVER_U8G2_CUSTOM)
static void renderFrame1Bit() {
#if defined(DISPLAY_DRIVER_TFT) || defined(DISPLAY_DRIVER_ST7789)
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
#endif

// ── setup ─────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);

#if defined(DISPLAY_DRIVER_TFT) || defined(DISPLAY_DRIVER_ILI9341) || defined(DISPLAY_DRIVER_ST7789)
  tft.init();
  tft.setRotation(1);        // landscape 320x240
  tft.fillScreen(TFT_BLACK);
  #ifdef TFT_BL
    pinMode(TFT_BL, OUTPUT);
    digitalWrite(TFT_BL, HIGH); // backlight on
  #endif
#elif defined(DISPLAY_DRIVER_ARDUINO_GFX)
  gfx->begin();
  gfx->fillScreen(BLACK);
#else
  Wire.begin(I2C_SDA, I2C_SCL);
  u8g2.begin();
  u8g2.setBusClock(400000);
#endif

  bool videoOpened = false;

#ifdef HAS_SD_CARD
  // The CYD board has a MicroSD card slot. Try to mount it first — if a
  // previous BLE upload was too big for SPIFFS, the video lives here.
  if (ensureSDMounted()) {
    videoFile = SD.open("/video.dat", "r");
    if (videoFile) {
      Serial.println("Found /video.dat on SD Card!");
      videoOpened = true;
      videoOnSD   = true;
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
  
  // Start BLE Server (CYD / ESP32-2432S028 only)
#ifdef HAS_BLE
  setupBLE();
#endif
}

static uint32_t currentFrame = 0;

// ── loop ──────────────────────────────────────────────────────────────────────
void loop() {
#ifdef HAS_BLE
  if (isReceivingVideo) {
    return; // Pause playback during BLE transfer
  }
#endif
  uint32_t now = millis();
  if (now - lastFrameAt < frameIntervalMs) return;
  lastFrameAt += frameIntervalMs;

  if (header.colorMode == 2) {
    if (readAndRenderColorFrame()) {
      currentFrame++;
      if (currentFrame >= header.frameCount) currentFrame = 0;
      Serial.printf("FRAME:%u/%u\n", currentFrame, header.frameCount);
    }
  } else {
#if defined(DISPLAY_DRIVER_SSD1306) || defined(DISPLAY_DRIVER_SH1106) || defined(DISPLAY_DRIVER_U8G2_CUSTOM)
    if (!readNextFrame1Bit()) {
      currentFrame = 0; // Reset on loop/end
      return;
    }
    renderFrame1Bit();
    currentFrame++;
    
    static uint32_t lastDebugTime = 0;
    if (millis() - lastDebugTime > 250) {
      lastDebugTime = millis();
      Serial.printf("FRAME:%u/%u\nFRAME_DATA:", currentFrame, header.frameCount);
      
      const char hexMap[] = "0123456789ABCDEF";
      char outBuf[65];
      outBuf[64] = 0;
      for (size_t i = 0; i < FRAME_BYTES; i += 32) {
        for(int j=0; j<32; j++) {
          uint8_t b = frameBuf[i+j];
          outBuf[j*2]   = hexMap[b >> 4];
          outBuf[j*2+1] = hexMap[b & 0xF];
        }
        Serial.print(outBuf);
      }
      Serial.println();
    } else {
      Serial.printf("FRAME:%u/%u\n", currentFrame, header.frameCount);
    }
#endif
  }
}
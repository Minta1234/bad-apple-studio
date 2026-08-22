# Bad Apple Studio — Update Log

## v2.1.0 — Android App + Multi-Board Color Support + BLE Reliability

### 🆕 Android Companion App

A full-featured **Android app** has been added under `App/android/`, built with Jetpack Compose (Material 3). It brings the complete desktop workflow to your phone:

- **Step 1: Select CYD Board** — Dropdown with all 6 supported boards (2.8" to 7.0")
- **Step 2: Select Media** — Pick an image or video from your phone's gallery
- **Step 3: Screen Rotation & Zoom** — Live preview with sliders for rotation (0–360°), zoom (0.5–5×), pan X/Y, and a Reset button. The preview box matches the real board resolution for accurate comparison.
- **Step 4: Convert** — FFmpeg-based conversion to RGB565 `.dat` format via WorkManager (runs in background). Includes a **Cancel Conversion** button so you're never stuck waiting.
- **Step 5: Connect & Upload** — BLE scanning, device selection, and upload to `BadApple_Studio` boards with progress bar and retry logic.

**UI Theme:** Matches the Electron desktop app — light gradient background (cyan → pink), white cards, monospace step headers, consistent branding.

#### Supported Boards (Android)

| Board | Screen Size | Resolution | Driver |
|-------|------------|------------|--------|
| ESP32-2432S028 | 2.8" | 320×240 | ILI9341 SPI |
| ESP32-2432S032 | 3.2" | 320×240 | ST7789 SPI |
| ESP32-3248S035 | 3.5" | 480×320 | ST7796 SPI |
| ESP32-4827S043 | 4.3" | 480×272 | RGB Parallel |
| ESP32-8048S043 | 4.3" | 800×480 | RGB Parallel |
| ESP32-8048S070 | 7.0" | 800×480 | RGB Parallel |

#### Android Build & Install

```bash
cd App/android
.\gradlew assembleDebug
adb install app\build\outputs\apk\debug\app-debug.apk
```

**Dependencies:** FFmpegKit (video processing), Coil (image/video preview), Jetpack WorkManager (background conversion).

---

### 🔧 Firmware Fixes

#### DRAM Overflow Fix for ESP32-2432S032 (CYD 3.2")

The `ESP32-2432S032` environment was failing to link with:
```
region 'dram0_0_seg' overflowed by 21664 bytes
```

**Root cause:** The 1-bit frame buffers (`frameBuf` + `payload`, ~86KB total) were being allocated for *all* non-ILI9341 boards. Since the S032 uses an ST7789 driver (color, RGB565), these B&W buffers were unnecessary but still consumed DRAM, leaving insufficient room for the NimBLE stack.

**Fix:** Changed `#ifndef DISPLAY_DRIVER_ILI9341` guards to explicit opt-in:
```cpp
#if defined(DISPLAY_DRIVER_SSD1306) || defined(DISPLAY_DRIVER_SH1106) || defined(DISPLAY_DRIVER_U8G2_CUSTOM)
```

This applies to:
- Frame buffer allocations (`frameBuf`, `payload`)
- `decodeFrame()` — RLE decoder
- `readNextFrame1Bit()` — 1-bit frame reader
- `renderFrame1Bit()` — 1-bit renderer
- 1-bit playback branch in `loop()`

**Result:** RAM usage dropped from overflow → **18.1% (59KB / 328KB)**.

---

### 📶 BLE Upload Reliability Improvements

BLE uploads were failing mid-transfer with `GATT operation failed for unknown reason` due to the ESP32's BLE buffer being overwhelmed.

#### Electron (Desktop) — `web/bluetooth.html`

- **Increased chunk delay** from `10ms` → `25ms` between writes
- **Added retry logic**: up to 3 retries per chunk with exponential backoff (200ms, 400ms, 600ms)
- On failure, the same chunk is re-sent instead of aborting the entire upload

#### Android — `BleUploadManager.kt`

- **Added retry logic**: up to 3 retries per GATT write failure
- Stores `lastChunk` for retry on error
- Uses `Handler.postDelayed()` with increasing delay (200ms × retryCount)
- Only disconnects after all retries are exhausted

---

### 📋 Summary of Changed Files

| File | Change |
|------|--------|
| `App/android/` | **[NEW]** Complete Android companion app |
| `firmware/src/main.cpp` | Fixed DRAM overflow — 1-bit buffers only for OLED displays |
| `firmware/platformio.ini` | Added `ESP32-2432S032` environment (ST7789, 320×240) |
| `web/bluetooth.html` | BLE upload retry logic + increased delay |

---

### 📝 What to Add to README.md

The following sections should be added to the main `README.md`:

1. **Android App section** — Build instructions, supported boards table, feature overview
2. **Updated board support table** — Now supports 8 boards (2 OLED + 6 CYD/RGB)
3. **BLE Upload section** — How wireless upload works (both desktop and Android)
4. **Updated architecture diagram** — Add Android → BLE → ESP32 path alongside USB flash path

# Bad Apple Studio — Local Video to ESP32 OLED Flasher

Run entirely locally: Upload video → Backend converts/compresses into 1-bit frame data → Compile firmware based on chosen display (0.96" SSD1306 or 1.3" SH1106) → Generate LittleFS image → Web flasher interface (esp-web-tools) flashes directly via USB.

## Architecture

```
video (mp4/...)
   │  ffmpeg: resize→128x64, grayscale, N fps
   ▼
raw grayscale frames (pgm)
   │  threshold → 1-bit → RLE (varint) — backend/src/lib/packFrames.js
   ▼
video.dat  (header + RLE frames)
   │  mkspiffs -c <dir> -s 0x160000 littlefs.bin
   ▼
littlefs.bin  ──┐
                ├─ manifest.json (dynamic, per job) ──► esp-web-tools ──► ESP32 via USB
firmware.bin  ──┘
(compiled per job using PlatformIO according to chosen env: esp32-oled096 / esp32-oled130)

```

**Reason for recompiling firmware per job:**
Written from scratch using PlatformIO + U8g2 (supporting both SSD1306 and SH1106 via the same compile-time class structure). Each display type corresponds to a different `env` in `platformio.ini` — the backend executes `pio run -e <env>` per job and scrapes the output binaries from `.pio/build/<env>/`.

> **Note:** Both specified display sizes (0.96" and 1.3") share the exact same resolution (**128x64**). They only differ in their driver chips (SSD1306 vs SH1106). Therefore, the video processing pipeline uses a fixed 128x64 constant rather than parametrizing by display size. If displays with different resolutions are added in the future, width and height can be parametrized.

---

## Prerequisites & Installation (One-Time Setup)

```bash
# 1) ffmpeg (frame extraction + resize + grayscale)
sudo apt install ffmpeg          # or `brew install ffmpeg` on macOS

# 2) PlatformIO Core CLI (compiles firmware + includes filesystem tools)
pip install platformio --break-system-packages
pio pkg install -g -p espressif32   # Pre-download ESP32 toolchain (avoids lag on first job)

# 3) Backend dependencies
cd backend && npm install

```

---

## Running the Server

```bash
cd backend
node server.js
# Open http://localhost:3000 in your browser

```

The web interface (`web/index.html`) is served directly by the backend (eliminates CORS issues and runs in a single process). Web Serial works seamlessly because it runs over `localhost`.

---

## Security & Production Considerations

* **Upload Constraints:** Restrict maximum file upload sizes and MIME types in Multer (`backend/server.js`).
* **Path Traversal Defense:** Generate random UUIDs for job IDs; never trust direct file paths submitted by client requests.
* **Resource Cleanup:** Delete uploaded video files and temporary frame files after every job completes or errors out (handled inside a `finally` block).
* **Local Binding:** Bind the server strictly to `127.0.0.1`. If exposing the application over a LAN, implement authentication first, as endpoints trigger firmware compilation from request parameters (acting as a potential attack surface).

---

## OLED to ESP32 Pinout (I2C)

| ESP32 Pin | OLED Pin |
| --- | --- |
| **3V3** | VCC |
| **GND** | GND |
| **GPIO21** | SDA |
| **GPIO22** | SCL |

*(Matches default U8g2 hardware I2C pins on standard ESP32 development boards. If your board uses custom pins, update `Wire.begin(...)` in `firmware/src/main.cpp`.)*
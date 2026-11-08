# Bad Apple Studio — Update Log






## v4.3.0

### 🚀 New Features
- initialize Android Gradle wrapper and settings configuration (5d623b5)

### 🐛 Bug Fixes & Stability
- use reliable direct mirror for Gradle distribution to avoid 504 timeouts (628569c)

---

## v4.2.0

### 🚀 New Features
- unify full end-to-end CI/CD pipeline with automatic testing, version bump, changelog, and release (36382e9)

### 🔧 Maintenance & Enhancements
- add android and kotlin build artifacts to gitignore (1103baf)

---

## v4.1.2

### 🖥️ Desktop App (Electron)
- Updates and improvements.

### 📱 Android APK
- Updates and improvements.

---
## v4.1.1

### 🖥️ Desktop App (Electron)
- Updates and improvements.

### 📱 Android APK
- Updates and improvements.

---
## v4.1.0

### 🚀 New Features
- add CI code verification workflow and auto-changelog generator (1051433)

### 🐛 Bug Fixes & Stability
- remove pip cache option from python setup (5e8a32c)

---

## v4.0.1 — Direct Numeric Controls & Android Service Fixes

### 🖥️ Desktop App (Electron) & Web Interface
- **Direct Numeric Controls**:
  - Added typed number input fields next to sliders for Rotation (0°–360°), Zoom (0.5×–5.0×), Pan X (-300 to 300), and Pan Y (-300 to 300).
  - Implemented real-time two-way synchronization: typing immediately updates sliders and live canvas/video preview transforms, and moving sliders updates the inputs.
  - Added auto-select on focus for rapid keyboard entry.
  - Supported across both Web flasher interface (`index.html`) and Bluetooth/Serial upload interface (`bluetooth.html`).
- **Backend & Connectivity**:
  - Added CORS support to Express backend for local and cross-origin device connectivity.

### 📱 Android APK
- **Android 14+ Compatibility Fix**:
  - Resolved `InvalidForegroundServiceTypeException` crash during background video conversion on Android 14+ by adopting `FOREGROUND_SERVICE_DATA_SYNC`.
  - Added backward-compatible fallback for pre-Android 10 devices.

---

## v4.0.0 — Color Previews & Reliable USB Serial Uploads

### 🖥️ Desktop App (Electron)
- **USB Serial Upload Stabilization**:
  - Fixed a critical race condition that caused the ESP32 to crash (`POWERON_RESET`) or timeout during serial uploads.
  - Buffer Optimization: Reverted to safe 128-byte chunks with 40ms delays to prevent the ESP32's Hardware UART FIFO (128 bytes) from overflowing while internal flash (SPIFFS) is busy writing data.
  - Handshake Protocol: Implemented the `load_serial` command to gracefully pause the video rendering loop on the board before starting an upload.
- **Accurate Color Previews**:
  - Replaced the old 1-bit B&W preview with full RGB565 accurate color preview generation in the backend, matching CYD color screen displays.
- **UI Enhancements**:
  - Clarified the "Use SD card" checkbox to correctly indicate it works for both BLE and Serial USB uploads.
  - Added View Logs.

### 📱 Android APK
- Maintained the stable BLE upload pipeline introduced in v2.1.0 with Android 14+ service updates.


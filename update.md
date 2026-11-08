# Bad Apple Studio — v4.0.1 Update Notes

## Summary of Changes
- **Screen Rotation & Zoom Controls**:
  - Added direct numeric typing for **Rotation** (0°–360°), **Zoom** (0.5×–5.0×), **Pan X** (-300 to 300), and **Pan Y** (-300 to 300) in both the Web flasher (`index.html`) and Bluetooth/Serial upload interface (`bluetooth.html`).
  - Added two-way sync between numeric input fields and range sliders, along with auto-focus selection for effortless keyboard input.
- **Backend Enhancements**:
  - Added Express `cors` middleware to allow cross-origin requests during local development and wireless device connections.
- **Android 14+ Foreground Service Crash Fix**:
  - Fixed `android.app.InvalidForegroundServiceTypeException: Starting FGS with type none callerApp=ProcessRecord(...) targetSDK=36 has been prohibited` on Android 14 devices.
  - Replaced `FOREGROUND_SERVICE_TYPE_MEDIA_PROCESSING` with `FOREGROUND_SERVICE_TYPE_DATA_SYNC` in `ConvertWorker.kt` and `AndroidManifest.xml`.
  - Added compatibility fallback for pre-Android 10 devices.
- **Build & CI/CD**:
  - Version incremented to `4.0.1` (Android `versionCode: 2`, `versionName: "4.0.1"`).
  - Added GitHub Actions automated release pipeline for building Windows `.exe`, `.zip`, and Android `.apk`, with changelog generation and asset publishing.

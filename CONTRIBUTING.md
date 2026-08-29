# Contributing to Bad Apple Studio

First off, thank you for considering contributing to Bad Apple Studio! It's people like you that make this tool better for everyone.

## Where do I go from here?

If you've noticed a bug or have a feature request, make sure to check if there's already an [Issue](../../issues) about it. If not, feel free to open a new one!

## Development Setup

If you want to contribute code to the desktop application or firmware, follow these steps:

### Desktop App (Electron)
1. Ensure you have **Node.js** (v14+) installed.
2. Clone the repository: `git clone https://github.com/Minta1234/bad-apple-studio.git`
3. Run `npm install` to install dependencies.
4. Run `npm start` to start the app in development mode.
5. To build the executable, run `Build Exe.bat` or `npm run build:win`.

### Android App
1. Open the `App/android` folder in **Android Studio**.
2. Sync Gradle and build the project.
3. You can run the app directly on an emulator or a physical device.

### Firmware (ESP32)
1. The firmware uses **PlatformIO**. It's recommended to install the PlatformIO extension in VS Code.
2. Open the `firmware/` folder in VS Code.
3. Make your modifications to `src/main.cpp` or `platformio.ini`.

## Pull Requests

1. **Fork** the repository and create your branch from `main`.
2. If you've added code that should be tested, please manually test it on at least one CYD board if possible.
3. Ensure the UI looks consistent (we use Bootstrap on the web app and Material 3 on Android).
4. Update documentation (like `update.md` or Wiki) if you change any user-facing features.
5. Issue that pull request!

## Code Style

* **JavaScript/Node:** We use standard JS conventions. Try to match the existing indentation and style (2 spaces).
* **C++:** Standard C++ naming conventions. Avoid blocking delays (`delay()`) in the main loop to keep the serial buffer clean.
* **Kotlin:** Standard Kotlin style guidelines.

Thanks again for your contribution!

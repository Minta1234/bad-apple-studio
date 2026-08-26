# Portable runtime files for the Windows executable

The release build copies this directory to `resources/tools`, ahead of the
machine PATH. Populate it on the release machine before running `npm run build`:

* `ffmpeg/ffmpeg.exe` and `ffmpeg/ffprobe.exe` (a Windows FFmpeg build)
* `platformio/` — a portable Python environment containing PlatformIO, with
  `Scripts/pio.exe`
* `platformio-core/` — the PlatformIO core directory with the required
  Espressif platforms, frameworks, libraries and toolchains already installed

These binaries are intentionally not committed to source control. They are
large, platform-specific third-party artifacts. Once included in this folder,
the generated `.exe` has no Python, PlatformIO, FFmpeg, Git, winget, or pip
prerequisite on the user's PC.

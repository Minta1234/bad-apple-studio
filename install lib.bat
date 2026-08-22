@echo off
REM ============================================================
REM  Bad Apple Studio - Windows installer
REM  Installs: Node.js, Python, ffmpeg, PlatformIO Core, npm deps
REM  Comments are English-only on purpose: cmd.exe's default
REM  codepage mangles Thai text unless chcp 65001 is set, and
REM  even then some Windows terminals still render it wrong -
REM  not worth the risk in a script meant to "just work".
REM ============================================================

setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ================================================
echo  Bad Apple Studio - installer
echo ================================================
echo.

where winget >nul 2>nul
if errorlevel 1 (
    echo [ERROR] winget was not found.
    echo Install "App Installer" from the Microsoft Store first,
    echo then run this script again.
    pause
    exit /b 1
)

set NEED_RESTART=0

REM ---------------------------------------------------------
REM Node.js
REM ---------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
    echo [1/4] Node.js not found - installing...
    winget install --id OpenJS.NodeJS.LTS --source winget
    set NEED_RESTART=1
) else (
    echo [1/4] Node.js already installed - skipping
)

REM ---------------------------------------------------------
REM Python (needed for PlatformIO Core, which is a Python tool)
REM ---------------------------------------------------------
where python >nul 2>nul
if errorlevel 1 (
    echo [2/4] Python not found - installing...
    winget install --id Python.Python.3.12 --source winget
    set NEED_RESTART=1
) else (
    echo [2/4] Python already installed - skipping
)

REM ---------------------------------------------------------
REM ffmpeg
REM ---------------------------------------------------------
where ffmpeg >nul 2>nul
if errorlevel 1 (
    echo [3/4] ffmpeg not found - installing...
    winget install --id Gyan.FFmpeg --source winget
    set NEED_RESTART=1
) else (
    echo [3/4] ffmpeg already installed - skipping
)

if "%NEED_RESTART%"=="1" (
    echo.
    echo ================================================
    echo  Just installed new tools via winget.
    echo  Windows only refreshes PATH in a NEW terminal,
    echo  so this session can't see them yet.
    echo.
    echo  Close this window, open a fresh Command Prompt
    echo  or PowerShell, then run install.bat again to
    echo  finish the remaining steps ^(PlatformIO + npm^).
    echo ================================================
    pause
    exit /b 0
)

REM ---------------------------------------------------------
REM PlatformIO Core (Python package) + ESP32 toolchain
REM ---------------------------------------------------------
echo [4/4] Installing PlatformIO Core + ESP32 toolchain...
python -m pip install --upgrade platformio
if errorlevel 1 (
    echo [ERROR] pip install platformio failed.
    echo Check that the Python install above actually completed.
    pause
    exit /b 1
)

python -m platformio pkg install -g -p espressif32
if errorlevel 1 (
    echo [ERROR] PlatformIO could not download the ESP32 toolchain.
    echo Check your internet connection and try again.
    pause
    exit /b 1
)

REM ---------------------------------------------------------
REM Backend npm dependencies
REM ---------------------------------------------------------
echo.
echo Installing backend dependencies...
if not exist "backend\package.json" (
    echo [ERROR] backend\package.json not found.
    echo Run this script from the project root ^(next to run.bat^).
    pause
    exit /b 1
)

echo [5/5] Installing root dependencies (Electron)...
call npm install
if errorlevel 1 (
    echo [ERROR] npm install in root failed.
    pause
    exit /b 1
)

pushd backend
echo Installing backend dependencies...
call npm install
if errorlevel 1 (
    echo [ERROR] npm install in backend failed - see the output above.
    popd
    pause
    exit /b 1
)
popd

echo.
echo ================================================
echo  Install complete.
echo  Run Build.bat to Build the App.
echo  Then run Run.bat to start the Bad Apple Studio app.
echo ================================================
pause
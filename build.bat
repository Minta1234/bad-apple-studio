@echo off
echo Installing Node dependencies...
call npm install
echo Building Electron App...
call npm run build
echo Building all Firmware environments...
call pio run -e esp32-st7789-19 -d firmware
call pio run -e esp32s3mini-st7789-19 -d firmware
call pio run -e ESP32-2432S028 -d firmware
call pio run -e ESP32-2432S032 -d firmware
call pio run -e ESP32-3248S035 -d firmware
call pio run -e ESP32-4827S043 -d firmware
call pio run -e ESP32-8048S043 -d firmware
call pio run -e ESP32-8048S070 -d firmware


echo Build Complete!

# Bad Apple Studio — local video → ESP32 OLED flasher

รันทั้งหมด local: อัปโหลดวิดีโอ → backend แปลง/บีบอัดเป็นข้อมูลเฟรม 1-bit →
compile firmware ตามจอที่เลือก (0.96" SSD1306 หรือ 1.3" SH1106) →
สร้าง SPIFFS image → เว็บหน้า flasher (esp-web-tools) แฟลชผ่าน USB ได้เลย

## สถาปัตยกรรม

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
                ├─ manifest.json (dynamic, per job) ──► esp-web-tools ──► ESP32 ผ่าน USB
firmware.bin  ──┘
(compiled ต่อ job ด้วย PlatformIO ตาม env ที่เลือก: esp32-oled096 / esp32-oled130)
```

**เหตุผลที่ compile firmware ใหม่ทุกครั้ง (ทางเลือก B ตามที่ระบุ):** ไม่มีซอร์ส firmware
เดิม เขียนใหม่ทั้งหมดด้วย PlatformIO + U8g2 (รองรับทั้ง SSD1306/SH1106 ผ่าน compile-time
class เดียวกัน) แต่ละ display เป็นคนละ `env` ใน `platformio.ini` — backend เรียก
`pio run -e <env>` ต่อ job แล้ว scrape output binaries จาก `.pio/build/<env>/`

**หมายเหตุ:** จอทั้งสองขนาดที่ระบุ (0.96" กับ 1.3") เป็นความละเอียด **128x64 เท่ากัน**
ต่างกันแค่ driver chip (SSD1306 vs SH1106) — ดังนั้น pipeline แปลงวิดีโอใช้ค่าคงที่
128x64 ตัวเดียว ไม่ต้อง parametrize ตาม "ขนาดจอ" จริง ๆ ถ้าใช้จอความละเอียดอื่นในอนาคต
ค่อยเพิ่ม width/height เป็นพารามิเตอร์

## ติดตั้งก่อนใช้งาน (ครั้งเดียว)

```bash
# 1) ffmpeg (แตกเฟรม + resize + grayscale)
sudo apt install ffmpeg          # หรือ brew install ffmpeg บน macOS

# 2) PlatformIO core CLI (compile firmware + มี mkspiffs มาให้ในตัว)
pip install platformio --break-system-packages
pio pkg install -g -p espressif32   # ดึง toolchain ESP32 มาไว้ล่วงหน้า (จะได้ไม่ช้าตอน job แรก)

# 3) backend deps
cd backend && npm install
```

## รัน

```bash
cd backend
node server.js
# เปิด http://localhost:3000
```

หน้าเว็บ (`web/index.html`) เสิร์ฟจาก backend เดียวกัน (ไม่มีปัญหา CORS, ไม่ต้องรัน
สอง process) — Web Serial ใช้ได้เพราะเป็น `localhost`

## ความปลอดภัย / ข้อควรระวัง (สำคัญกับงาน backend รับไฟล์อัปโหลด)

- จำกัดขนาดไฟล์อัปโหลดและ mime type ที่ multer (`backend/server.js`)
- job id เป็น UUID สุ่ม ไม่รับ path จาก client ตรง ๆ (กัน path traversal)
- ลบไฟล์ใน `uploads/` และไฟล์ frame ชั่วคราวหลัง job เสร็จ/error ทุกครั้ง (`finally` block)
- รันเซิร์ฟเวอร์นี้ผูกกับ `127.0.0.1` เท่านั้น — ถ้าจะเปิดให้เครื่องอื่นในวง LAN เข้าถึง
  ต้องเพิ่ม auth ก่อน เพราะตอนนี้ไม่มีการยืนยันตัวตนเลย และ endpoint สั่ง compile
  โค้ดจาก request ได้ (แม้จะจำกัด parameter ก็ตาม ควรมองเป็น attack surface)

## ต่อจอเข้ากับ ESP32 (I2C)

| ESP32 pin | OLED pin |
|---|---|
| 3V3 | VCC |
| GND | GND |
| GPIO21 | SDA |
| GPIO22 | SCL |

(ตรงตาม default I2C pin ของ U8g2 hardware I2C บน ESP32 dev board ทั่วไป —
ถ้าบอร์ดจริงต่อขาอื่น แก้ที่ `firmware/src/main.cpp` บรรทัด `Wire.begin(...)`)

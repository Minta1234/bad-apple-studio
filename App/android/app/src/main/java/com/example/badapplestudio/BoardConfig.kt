package com.example.badapplestudio

data class BoardConfig(
    val id: String,
    val name: String,
    val description: String,
    val width: Int,
    val height: Int
)

object SupportedBoards {
    val boards = listOf(
        BoardConfig("ESP32-2432S028", "ESP32-2432S028", "2.8\" (320x240) ILI9341 SPI", 320, 240),
        BoardConfig("ESP32-2432S032", "ESP32-2432S032", "3.2\" (320x240) ST7789 SPI", 320, 240),
        BoardConfig("ESP32-3248S035", "ESP32-3248S035", "3.5\" (480x320) ST7796 SPI", 480, 320),
        BoardConfig("ESP32-4827S043", "ESP32-4827S043", "4.3\" (480x272) RGB Parallel", 480, 272),
        BoardConfig("ESP32-8048S043", "ESP32-8048S043", "4.3\" (800x480) RGB Parallel High-Res", 800, 480),
        BoardConfig("ESP32-8048S070", "ESP32-8048S070", "7.0\" (800x480) RGB Parallel", 800, 480)
    )
}

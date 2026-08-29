package com.example.badapplestudio

import android.content.Context
import android.content.Intent
import android.app.PendingIntent
import android.hardware.usb.UsbManager
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.driver.UsbSerialProber
import java.io.File
import java.io.FileInputStream

/** Sends video.dat through an ESP32 USB-UART using the firmware BAS protocol. */
class SerialUploadManager(context: Context) {
    private val appContext = context
    private val usbManager = context.getSystemService(Context.USB_SERVICE) as UsbManager
    private var port: UsbSerialPort? = null

    fun available(): Boolean = UsbSerialProber.getDefaultProber().findAllDrivers(usbManager).isNotEmpty()

    fun connect(): Result<Unit> = runCatching {
        val driver = UsbSerialProber.getDefaultProber().findAllDrivers(usbManager).firstOrNull()
            ?: error("No USB serial device found")
        if (!usbManager.hasPermission(driver.device)) {
            val intent = PendingIntent.getBroadcast(
                appContext, 0, Intent("com.example.badapplestudio.USB_PERMISSION"),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            usbManager.requestPermission(driver.device, intent)
            error("USB permission requested. Allow it, then tap Connect again.")
        }
        val connection = usbManager.openDevice(driver.device) ?: error("Could not open USB device")
        val serial = driver.ports.firstOrNull() ?: error("USB device has no serial port")
        serial.open(connection)
        serial.setParameters(115200, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
        port = serial
    }

    fun disconnect() { try { port?.close() } catch (_: Exception) { }; port = null }

    fun upload(file: File, onProgress: (Float) -> Unit): Result<Unit> = runCatching {
        val serial = port ?: error("USB serial is not connected")
        val total = file.length().coerceAtMost(Int.MAX_VALUE.toLong())
        serial.write("BAS:START:$total\n".toByteArray(), 3000)
        val response = readLine(serial, 5000)
        if (response.startsWith("BAS:ERROR:")) error(response)
        FileInputStream(file).use { input ->
            val buffer = ByteArray(256); var sent = 0L
            while (sent < total) {
                val count = input.read(buffer, 0, minOf(buffer.size.toLong(), total - sent).toInt())
                if (count <= 0) break
                serial.write(buffer.copyOf(count), 3000); sent += count
                onProgress(sent.toFloat() / total.toFloat()); Thread.sleep(40)
            }
        }
        val done = readLine(serial, 10000)
        if (done != "BAS:OK:DONE") error(done.ifBlank { "Upload timed out" })
        onProgress(1f)
    }

    private fun readLine(serial: UsbSerialPort, timeout: Int): String {
        val bytes = ByteArray(128); val out = StringBuilder(); val start = System.currentTimeMillis()
        while (System.currentTimeMillis() - start < timeout) {
            val n = serial.read(bytes, 250)
            if (n > 0) { out.append(String(bytes, 0, n)); val end = out.indexOf("\n"); if (end >= 0) return out.substring(0, end).trim() }
        }
        return out.toString().trim()
    }
}

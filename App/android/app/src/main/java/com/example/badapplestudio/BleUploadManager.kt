package com.example.badapplestudio

import android.annotation.SuppressLint
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.Context
import android.os.ParcelUuid
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import java.io.File
import java.io.FileInputStream
import java.util.UUID

@SuppressLint("MissingPermission")
class BleUploadManager(private val context: Context) {
    private val bluetoothManager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    private val bluetoothAdapter: BluetoothAdapter? get() = bluetoothManager?.adapter
    val isBluetoothAvailable: Boolean get() = bluetoothAdapter != null
    val isBluetoothEnabled: Boolean
        get() = try {
            bluetoothAdapter?.isEnabled == true
        } catch (_: SecurityException) {
            false
        }
    private val scanner: BluetoothLeScanner?
        get() = try {
            bluetoothAdapter?.bluetoothLeScanner
        } catch (_: SecurityException) {
            null
        }
    private var bluetoothGatt: BluetoothGatt? = null

    // UUIDs must match the ESP32 BleServer.h
    private val SERVICE_UUID = UUID.fromString("12345678-1234-5678-1234-56789abcdef0")
    private val CHAR_UUID = UUID.fromString("12345678-1234-5678-1234-56789abcdef1")

    fun scanDevices(): Flow<BluetoothDevice> = callbackFlow {
        val currentScanner = scanner
        if (currentScanner == null) {
            close()
            return@callbackFlow
        }

        val scanCallback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val deviceName = result.device.name ?: result.scanRecord?.deviceName
                if (deviceName != null && (deviceName.startsWith("BadApple") || deviceName.contains("BadApple", ignoreCase = true))) {
                    trySend(result.device)
                }
            }
            override fun onBatchScanResults(results: MutableList<ScanResult>?) {
                results?.forEach { result ->
                    val deviceName = result.device.name ?: result.scanRecord?.deviceName
                    if (deviceName != null && (deviceName.startsWith("BadApple") || deviceName.contains("BadApple", ignoreCase = true))) {
                        trySend(result.device)
                    }
                }
            }
            override fun onScanFailed(errorCode: Int) {
                android.util.Log.e("BleScan", "Scan failed with error: $errorCode")
            }
        }

        // Scan without UUID filter — some phones can't discover
        // BLE services by UUID during advertising. Filter by name instead.
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build()

        // Use emptyList() instead of null or strict name filters.
        // Some phones (Vivo) ignore null filters, while strict name filters fail if the 
        // device name is in the Scan Response packet rather than the main advert packet.
        val filters = emptyList<ScanFilter>()

        try {
            currentScanner.startScan(filters, settings, scanCallback)
        } catch (e: SecurityException) {
            android.util.Log.e("BleScan", "Scan failed: missing permission", e)
            close()
            return@callbackFlow
        }

        awaitClose {
            try {
                currentScanner.stopScan(scanCallback)
            } catch (_: SecurityException) {}
        }
    }

    fun connectAndUpload(device: BluetoothDevice, datFile: File, onProgress: (Float, String) -> Unit, onComplete: (Boolean, String?) -> Unit) {
        val totalBytes = datFile.length().toInt()
        var bytesUploaded = 0
        var startTime = 0L

        val gattCallback = object : BluetoothGattCallback() {
            private var uploadCharacteristic: BluetoothGattCharacteristic? = null
            private var fis: FileInputStream? = null
            private var retryCount = 0
            private val MAX_RETRIES = 3
            private var lastChunk: ByteArray? = null
            private var chunkSize = 180 // Safe default; updated after MTU negotiation
            
            override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    gatt.requestMtu(512) // Request maximum MTU
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    fis?.close()
                    onComplete(false, "Disconnected")
                    gatt.close()
                }
            }

            override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    // ATT header is 3 bytes, so usable payload = MTU - 3
                    chunkSize = (mtu - 3).coerceAtMost(490).coerceAtLeast(20)
                    android.util.Log.i("BleUpload", "MTU negotiated: $mtu → chunkSize=$chunkSize")
                }
                gatt.discoverServices()
            }

            override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    val service = gatt.getService(SERVICE_UUID)
                    uploadCharacteristic = service?.getCharacteristic(CHAR_UUID)
                    
                    if (uploadCharacteristic != null) {
                        // 1. Send START command (use acknowledged write for commands)
                        val startCmd = "START:$totalBytes".toByteArray()
                        uploadCharacteristic!!.value = startCmd
                        uploadCharacteristic!!.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                        gatt.writeCharacteristic(uploadCharacteristic)
                    } else {
                        onComplete(false, "Characteristic not found")
                        gatt.disconnect()
                    }
                }
            }

            override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    // Retry on failure instead of immediate disconnect
                    retryCount++
                    if (retryCount > MAX_RETRIES) {
                        onComplete(false, "Write failed after $MAX_RETRIES retries (status $status)")
                        gatt.disconnect()
                        return
                    }
                    // Retry the last chunk after a delay
                    android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                        lastChunk?.let {
                            characteristic.value = it
                            gatt.writeCharacteristic(characteristic)
                        }
                    }, (200 * retryCount).toLong())
                    return
                }

                retryCount = 0 // Reset retry count on success
                val written = characteristic.value
                val writtenString = String(written)

                if (writtenString.startsWith("START:")) {
                    // Start streaming data
                    startTime = System.currentTimeMillis()
                    fis = FileInputStream(datFile)
                    sendNextChunk(gatt, characteristic)
                } else if (writtenString == "END") {
                    // Upload complete
                    fis?.close()
                    onComplete(true, null)
                    // Allow ESP32 to finish writing, reloading, and rendering the new frame to the display
                    android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                        try {
                            gatt.disconnect()
                        } catch (_: Exception) {}
                    }, 1200)
                } else {
                    // A chunk was written, send the next
                    bytesUploaded += written.size
                    val elapsed = System.currentTimeMillis() - startTime
                    var speedStr = ""
                    if (elapsed > 0) {
                        val speedBps = (bytesUploaded.toDouble() / elapsed) * 1000
                        val speedKbps = speedBps / 1024.0
                        val uploadedKb = bytesUploaded / 1024.0
                        val totalKb = totalBytes / 1024.0
                        speedStr = String.format("%.1f KB/s  •  %.1f / %.1f KB", speedKbps, uploadedKb, totalKb)
                    }
                    onProgress(bytesUploaded.toFloat() / totalBytes, speedStr)
                    
                    // Small delay to let ESP32 process the previous chunk
                    android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                        sendNextChunk(gatt, characteristic)
                    }, 15)
                }
            }

            private fun sendNextChunk(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
                val buffer = ByteArray(chunkSize)
                val bytesRead = fis?.read(buffer) ?: -1
                
                if (bytesRead > 0) {
                    val chunk = buffer.copyOf(bytesRead)
                    lastChunk = chunk // Store for retry
                    characteristic.value = chunk
                    characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                    gatt.writeCharacteristic(characteristic)
                } else {
                    // Done reading file, send END
                    val endCmd = "END".toByteArray()
                    lastChunk = endCmd
                    characteristic.value = endCmd
                    characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                    gatt.writeCharacteristic(characteristic)
                }
            }
        }

        bluetoothGatt = device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
    }
}

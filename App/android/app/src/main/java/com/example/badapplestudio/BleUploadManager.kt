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
    private val STATUS_UUID = UUID.fromString("12345678-1234-5678-1234-56789abcdef2")
    private val CCCD_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

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

    private enum class UploadStage {
        IDLE,
        WAITING_START_ACK,
        SENDING_DATA,
        WAITING_END_ACK,
        DONE
    }

    fun connectAndUpload(device: BluetoothDevice, datFile: File, onProgress: (Float, String) -> Unit, onComplete: (Boolean, String?) -> Unit) {
        val totalBytes = datFile.length().toInt()
        var bytesUploaded = 0
        var startTime = 0L
        var isCompleted = false
        val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())

        val gattCallback = object : BluetoothGattCallback() {
            private var uploadCharacteristic: BluetoothGattCharacteristic? = null
            private var hasStatusChar = false
            private var fis: FileInputStream? = null
            private var retryCount = 0
            private val MAX_RETRIES = 4
            private var lastChunk: ByteArray? = null
            private var chunkSize = 180 // Safe default; updated after MTU negotiation
            private var uploadStarted = false
            private var stage = UploadStage.IDLE
            private var waitingForFlushAck = false
            private var startFallbackRunnable: Runnable? = null
            private var flushFallbackRunnable: Runnable? = null

            override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    try {
                        gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
                    } catch (_: Exception) {}
                    gatt.requestMtu(512) // Request maximum MTU
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    startFallbackRunnable?.let { mainHandler.removeCallbacks(it) }
                    flushFallbackRunnable?.let { mainHandler.removeCallbacks(it) }
                    fis?.close()
                    if (!isCompleted) {
                        isCompleted = true
                        onComplete(false, "Disconnected")
                    }
                    gatt.close()
                }
            }

            override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    // Cap at 240 bytes to ensure SPIFFS flash writes keep up and never drop bytes in the air
                    chunkSize = (mtu - 3).coerceAtMost(240).coerceAtLeast(20)
                    android.util.Log.i("BleUpload", "MTU negotiated: $mtu → chunkSize=$chunkSize")
                }
                gatt.discoverServices()
            }

            override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    val service = gatt.getService(SERVICE_UUID)
                    uploadCharacteristic = service?.getCharacteristic(CHAR_UUID)
                    val statusChar = service?.getCharacteristic(STATUS_UUID)

                    if (statusChar != null) {
                        hasStatusChar = true
                        gatt.setCharacteristicNotification(statusChar, true)
                        val descriptor = statusChar.getDescriptor(CCCD_UUID)
                        if (descriptor != null) {
                            descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                            gatt.writeDescriptor(descriptor)
                        } else {
                            startUploadSequence(gatt)
                        }
                    } else {
                        startUploadSequence(gatt)
                    }
                } else {
                    if (!isCompleted) {
                        isCompleted = true
                        onComplete(false, "Service discovery failed")
                    }
                    gatt.disconnect()
                }
            }

            override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
                startUploadSequence(gatt)
            }

            private fun startUploadSequence(gatt: BluetoothGatt) {
                if (uploadStarted) return
                uploadStarted = true
                val characteristic = uploadCharacteristic
                if (characteristic != null) {
                    stage = UploadStage.WAITING_START_ACK
                    val startCmd = "START:$totalBytes".toByteArray()
                    lastChunk = startCmd
                    characteristic.value = startCmd
                    characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                    gatt.writeCharacteristic(characteristic)
                } else {
                    if (!isCompleted) {
                        isCompleted = true
                        onComplete(false, "Upload characteristic not found")
                    }
                    gatt.disconnect()
                }
            }

            private fun beginStreamingData(gatt: BluetoothGatt) {
                if (stage != UploadStage.WAITING_START_ACK || isCompleted) return
                startFallbackRunnable?.let { mainHandler.removeCallbacks(it) }
                startFallbackRunnable = null
                stage = UploadStage.SENDING_DATA
                startTime = System.currentTimeMillis()
                fis = FileInputStream(datFile)
                val characteristic = uploadCharacteristic ?: return
                // Give the ESP32 100ms after opening /video.dat before streaming chunks
                mainHandler.postDelayed({
                    if (!isCompleted) sendNextChunk(gatt, characteristic)
                }, 100)
            }

            @Deprecated("Deprecated in Java")
            override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
                handleStatusNotification(gatt, characteristic.value)
            }

            override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
                handleStatusNotification(gatt, value)
            }

            private fun handleStatusNotification(gatt: BluetoothGatt, value: ByteArray?) {
                if (value == null || isCompleted) return
                val msg = String(value).trim()
                if (msg.startsWith("ACK:")) {
                    if (waitingForFlushAck) {
                        waitingForFlushAck = false
                        flushFallbackRunnable?.let { mainHandler.removeCallbacks(it) }
                        flushFallbackRunnable = null
                        val characteristic = uploadCharacteristic
                        if (characteristic != null && !isCompleted) {
                            mainHandler.post { sendNextChunk(gatt, characteristic) }
                        }
                    }
                    return
                }

                android.util.Log.i("BleUpload", "Board notification: $msg")
                if (msg == "OK:SPIFFS" || msg == "OK:SD") {
                    mainHandler.post { beginStreamingData(gatt) }
                } else if (msg == "OK:DONE") {
                    stage = UploadStage.DONE
                    isCompleted = true
                    fis?.close()
                    onComplete(true, null)
                    mainHandler.postDelayed({
                        try { gatt.disconnect() } catch (_: Exception) {}
                    }, 1200)
                } else if (msg.startsWith("ERROR:")) {
                    stage = UploadStage.DONE
                    isCompleted = true
                    startFallbackRunnable?.let { mainHandler.removeCallbacks(it) }
                    flushFallbackRunnable?.let { mainHandler.removeCallbacks(it) }
                    fis?.close()
                    val friendly = when {
                        msg.startsWith("ERROR:SIZE_MISMATCH") -> {
                            val details = if (msg.length > "ERROR:SIZE_MISMATCH:".length) " (${msg.substringAfter("ERROR:SIZE_MISMATCH:")} bytes)" else ""
                            "Transfer incomplete$details — some data was lost in the air. Move closer to the board and try again."
                        }
                        msg == "ERROR:NO_SPACE" -> "Not enough free storage on the board for this file."
                        msg == "ERROR:WRITE_FAIL" -> "Storage write failed mid-transfer (flash/SD error)."
                        msg == "ERROR:BAD_SIZE" -> "Board rejected the file size."
                        else -> msg
                    }
                    onComplete(false, friendly)
                    try { gatt.disconnect() } catch (_: Exception) {}
                }
            }

            override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
                if (isCompleted) return
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    retryCount++
                    if (retryCount > MAX_RETRIES) {
                        if (!isCompleted) {
                            isCompleted = true
                            onComplete(false, "Write failed after $MAX_RETRIES retries (status $status)")
                        }
                        gatt.disconnect()
                        return
                    }
                    mainHandler.postDelayed({
                        lastChunk?.let {
                            characteristic.value = it
                            characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                            gatt.writeCharacteristic(characteristic)
                        }
                    }, (200 * retryCount).toLong())
                    return
                }

                retryCount = 0

                when (stage) {
                    UploadStage.WAITING_START_ACK -> {
                        // Wait for OK:SPIFFS / OK:SD notification from board, with 2.5s fallback for legacy firmware
                        val fallback = Runnable {
                            beginStreamingData(gatt)
                        }
                        startFallbackRunnable = fallback
                        mainHandler.postDelayed(fallback, if (hasStatusChar) 2500L else 300L)
                    }
                    UploadStage.SENDING_DATA -> {
                        val chunkLen = lastChunk?.size ?: 0
                        val prevBytes = bytesUploaded
                        bytesUploaded += chunkLen
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

                        val crossesFlushBoundary = (prevBytes / 2048) != (bytesUploaded / 2048)
                        if (crossesFlushBoundary) {
                            // Wait for board's ACK:<bytes> after 2KB SPIFFS write, or 90ms fallback for older firmware
                            waitingForFlushAck = true
                            val fallback = Runnable {
                                if (waitingForFlushAck && !isCompleted) {
                                    waitingForFlushAck = false
                                    flushFallbackRunnable = null
                                    sendNextChunk(gatt, characteristic)
                                }
                            }
                            flushFallbackRunnable = fallback
                            mainHandler.postDelayed(fallback, 90L)
                        } else {
                            mainHandler.postDelayed({
                                if (!isCompleted) sendNextChunk(gatt, characteristic)
                            }, 6L)
                        }
                    }
                    UploadStage.WAITING_END_ACK -> {
                        fis?.close()
                        // Wait for board's OK:DONE / ERROR status notification, with 8s fallback timeout
                        mainHandler.postDelayed({
                            if (!isCompleted) {
                                isCompleted = true
                                onComplete(true, null)
                                try { gatt.disconnect() } catch (_: Exception) {}
                            }
                        }, 8000L)
                    }
                    else -> {}
                }
            }

            private fun sendNextChunk(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
                if (isCompleted) return
                val buffer = ByteArray(chunkSize)
                val bytesRead = fis?.read(buffer) ?: -1

                if (bytesRead > 0) {
                    val chunk = buffer.copyOf(bytesRead)
                    lastChunk = chunk
                    characteristic.value = chunk
                    characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                    gatt.writeCharacteristic(characteristic)
                } else {
                    // Wait 100ms before sending END so the final chunk is completely processed
                    mainHandler.postDelayed({
                        if (!isCompleted) {
                            stage = UploadStage.WAITING_END_ACK
                            val endCmd = "END".toByteArray()
                            lastChunk = endCmd
                            characteristic.value = endCmd
                            characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                            gatt.writeCharacteristic(characteristic)
                        }
                    }, 100L)
                }
            }
        }

        bluetoothGatt = device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
    }
}

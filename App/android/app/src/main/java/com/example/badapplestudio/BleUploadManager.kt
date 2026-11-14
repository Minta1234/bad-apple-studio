package com.example.badapplestudio

import android.annotation.SuppressLint
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.Context
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
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
    @Volatile private var bluetoothGatt: BluetoothGatt? = null

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

    private data class GattEvent(val kind: String, val status: Int = 0, val value: Int = 0, val message: String = "")

    fun connectAndUpload(device: BluetoothDevice, datFile: File, onProgress: (Float, String) -> Unit, onComplete: (Boolean, String?) -> Unit) {
        if (bluetoothGatt != null) {
            onComplete(false, "An upload is already running")
            return
        }
        val events = kotlinx.coroutines.channels.Channel<GattEvent>(kotlinx.coroutines.channels.Channel.UNLIMITED)
        val callback = object : BluetoothGattCallback() {
            override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
                events.trySend(GattEvent(if (newState == BluetoothProfile.STATE_CONNECTED) "connected" else "disconnected", status))
            }
            override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
                events.trySend(GattEvent("mtu", status, mtu))
            }
            override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
                events.trySend(GattEvent("services", status))
            }
            override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
                events.trySend(GattEvent("descriptor", status))
            }
            override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
                events.trySend(GattEvent("write", status))
            }
            @Deprecated("Deprecated in Java")
            override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
                if (characteristic.uuid == STATUS_UUID) events.trySend(GattEvent("notification", message = String(characteristic.value)))
            }
            override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
                if (characteristic.uuid == STATUS_UUID) events.trySend(GattEvent("notification", message = String(value)))
            }
        }
        val gatt = try {
            device.connectGatt(context.applicationContext, false, callback, BluetoothDevice.TRANSPORT_LE)
                ?: error("Unable to create Bluetooth connection")
        } catch (e: Exception) {
            events.close()
            onComplete(false, e.message)
            return
        }
        bluetoothGatt = gatt
        kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.IO).launch {
            val board = BleUploadStatus()
            var success = false
            var failure: String? = null
            suspend fun receive(): GattEvent {
                val event = events.receive()
                check(event.kind != "disconnected") { "Bluetooth disconnected (status ${event.status})" }
                if (event.kind == "notification") board.accept(event.message)
                return event
            }
            suspend fun awaitEvent(kind: String): GattEvent = kotlinx.coroutines.withTimeout(30_000L) {
                var event = receive()
                while (event.kind != kind) event = receive()
                check(event.status == BluetoothGatt.GATT_SUCCESS) { "Bluetooth $kind failed (status ${event.status}); restart the upload" }
                event
            }
            suspend fun awaitBoard(condition: () -> Boolean) = kotlinx.coroutines.withTimeout(30_000L) {
                while (!condition()) receive()
            }
            try {
                val totalBytes = datFile.length()
                require(datFile.isFile && totalBytes in 1..Int.MAX_VALUE.toLong()) { "Upload file is missing, empty or too large" }
                awaitEvent("connected")
                gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
                var chunkSize = 20
                if (gatt.requestMtu(512)) {
                    // An unsuccessful negotiation leaves the mandatory 23-byte MTU usable.
                    val mtu = kotlinx.coroutines.withTimeout(30_000L) {
                        var event = receive()
                        while (event.kind != "mtu") event = receive()
                        event
                    }
                    if (mtu.status == BluetoothGatt.GATT_SUCCESS) chunkSize = (mtu.value - 3).coerceIn(20, 240)
                }
                check(gatt.discoverServices()) { "Cannot start service discovery" }
                awaitEvent("services")
                val service = gatt.getService(SERVICE_UUID) ?: error("Upload service not found")
                val characteristic = service.getCharacteristic(CHAR_UUID) ?: error("Upload characteristic not found")
                val status = service.getCharacteristic(STATUS_UUID) ?: error("Board firmware needs upload status notifications; update the firmware")
                val descriptor = status.getDescriptor(CCCD_UUID) ?: error("Board notification descriptor missing")
                check(gatt.setCharacteristicNotification(status, true)) { "Cannot enable board notifications" }
                descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                check(gatt.writeDescriptor(descriptor)) { "Cannot subscribe to board notifications" }
                awaitEvent("descriptor")

                suspend fun write(data: ByteArray) {
                    characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                    characteristic.value = data
                    // Retrying an ambiguous write can append the same bytes twice: abort instead.
                    check(gatt.writeCharacteristic(characteristic)) { "Bluetooth rejected a write; restart the upload" }
                    awaitEvent("write")
                }
                FileInputStream(datFile).use { input ->
                    write("START:$totalBytes".toByteArray())
                    awaitBoard { board.ready }
                    val startedAt = android.os.SystemClock.elapsedRealtime()
                    var lastProgressAt = 0L
                    var sent = 0
                    val buffer = ByteArray(chunkSize)
                    while (sent < totalBytes) {
                        val length = minOf(chunkSize, 2048 - sent % 2048, (totalBytes - sent).toInt())
                        val count = input.read(buffer, 0, length)
                        check(count > 0) { "Upload file ended unexpectedly" }
                        write(buffer.copyOf(count))
                        sent += count
                        if (sent % 2048 == 0) awaitBoard { board.acknowledgedBytes >= sent }
                        val now = android.os.SystemClock.elapsedRealtime()
                        if (now - lastProgressAt >= 200 || sent.toLong() == totalBytes) {
                            val speed = sent * 1000.0 / (now - startedAt).coerceAtLeast(1) / 1024.0
                            onProgress(sent.toFloat() / totalBytes, String.format("%.1f KB/s  •  %.1f / %.1f KB", speed, sent / 1024.0, totalBytes / 1024.0))
                            lastProgressAt = now
                        }
                    }
                    board.allowCompletion = true
                    write("END".toByteArray())
                    awaitBoard { board.done }
                }
                success = true
            } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
                failure = "Timed out waiting for Bluetooth or board confirmation; upload was not verified"
            } catch (e: Exception) {
                failure = e.message ?: "Bluetooth upload failed"
            } finally {
                try {
                    gatt.disconnect()
                } catch (e: Exception) {
                    android.util.Log.w("BleUpload", "Disconnect failed", e)
                } finally {
                    gatt.close()
                    bluetoothGatt = null
                    events.close()
                }
            }
            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) {
                onComplete(success, failure)
            }
        }
    }
}

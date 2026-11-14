package com.example.badapplestudio

/** Retains notifications that can arrive before the corresponding GATT write callback. */
internal class BleUploadStatus {
    var ready = false
        private set
    var acknowledgedBytes = 0
        private set
    var allowCompletion = false
    var done = false
        private set

    fun accept(message: String) {
        val status = message.trim()
        when {
            status.startsWith("ERROR:") -> error("Board rejected upload: $status")
            status == "OK:SPIFFS" || status == "OK:SD" -> ready = true
            status.startsWith("ACK:") -> {
                val bytes = status.substringAfter(':').toIntOrNull()
                require(bytes != null && bytes >= 0) { "Invalid board acknowledgement: $status" }
                acknowledgedBytes = maxOf(acknowledgedBytes, bytes)
            }
            status == "OK:DONE" -> {
                check(allowCompletion) { "Board completed before all bytes were sent" }
                done = true
            }
        }
    }
}

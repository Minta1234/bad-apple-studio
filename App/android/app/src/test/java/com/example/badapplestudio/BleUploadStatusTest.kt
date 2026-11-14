package com.example.badapplestudio

import org.junit.Assert.*
import org.junit.Test

class BleUploadStatusTest {
    @Test fun retainsEarlyNotificationsAndIgnoresStaleAcknowledgements() {
        val status = BleUploadStatus()
        status.accept("OK:SPIFFS")
        status.accept("ACK:4096")
        status.accept("ACK:2048")
        assertTrue(status.ready)
        assertEquals(4096, status.acknowledgedBytes)
        assertFalse(status.done)
        status.allowCompletion = true
        status.accept("OK:DONE")
        assertTrue(status.done)
    }

    @Test(expected = IllegalStateException::class)
    fun rejectsPrematureCompletion() { BleUploadStatus().accept("OK:DONE") }

    @Test(expected = IllegalStateException::class)
    fun propagatesStorageFailure() { BleUploadStatus().accept("ERROR:WRITE_FAIL") }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsMalformedAcknowledgement() { BleUploadStatus().accept("ACK:invalid") }
}

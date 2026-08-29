package com.example.badapplestudio

import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

object VideoPackager {

    private const val HEADER_SIZE = 16

    /**
     * Packs raw RGB565LE frames (e.g., from FFmpeg) into the video.dat format.
     * @param rawVideoPath The path to the raw video output from FFmpeg.
     * @param outPath The destination path for video.dat.
     * @param width The video width (e.g., 320).
     * @param height The video height (e.g., 240).
     * @param fps The frames per second.
     */
    fun packRawRgb565(
        rawVideoPath: String,
        outPath: String,
        width: Int,
        height: Int,
        fps: Int,
        onProgress: ((completedFrames: Int, totalFrames: Int) -> Unit)? = null
    ) {
        val rawFile = File(rawVideoPath)
        val outFile = File(outPath)
        
        val frameSizeBytes = width * height * 2
        val frameCount = (rawFile.length() / frameSizeBytes).toInt()

        if (frameCount == 0) {
            throw IllegalArgumentException("Raw video file is too small for even one frame")
        }

        FileOutputStream(outFile).use { fos ->
            // 1. Write Header (16 bytes)
            val headerBuffer = ByteBuffer.allocate(HEADER_SIZE).order(ByteOrder.LITTLE_ENDIAN)
            headerBuffer.putShort(width.toShort())
            headerBuffer.putShort(height.toShort())
            headerBuffer.putInt(frameCount)
            headerBuffer.put(fps.toByte())
            headerBuffer.put(2) // colorMode = 2 (RGB565 raw)
            // Fill reserved bytes with 0
            for (i in 0 until 6) {
                headerBuffer.put(0)
            }
            fos.write(headerBuffer.array())

            // 2. Write Frames
            FileInputStream(rawFile).use { fis ->
                val buffer = ByteArray(frameSizeBytes)
                val lenBuffer = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN)
                lenBuffer.putInt(frameSizeBytes)
                val lenBytes = lenBuffer.array()

                var completedFrames = 0
                while (true) {
                    val bytesRead = fis.read(buffer)
                    if (bytesRead < frameSizeBytes) {
                        break // End of complete frames
                    }
                    
                    // Write 4-byte frame length
                    fos.write(lenBytes)
                    // Write frame data
                    fos.write(buffer)
                    completedFrames++
                    // Updating every frame is noisy for high-FPS clips. A
                    // small interval keeps the UI responsive with no memory cost.
                    if (completedFrames == frameCount || completedFrames % 10 == 0) {
                        onProgress?.invoke(completedFrames, frameCount)
                    }
                }
            }
        }
    }
}

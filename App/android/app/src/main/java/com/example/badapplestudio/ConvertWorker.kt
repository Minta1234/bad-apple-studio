package com.example.badapplestudio

import android.content.Context
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import android.net.Uri
import android.provider.OpenableColumns
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import com.arthenica.ffmpegkit.FFmpegKit
import com.arthenica.ffmpegkit.FFprobeKit
import com.arthenica.ffmpegkit.ReturnCode
import com.arthenica.ffmpegkit.Session
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

class ConvertWorker(appContext: Context, workerParams: WorkerParameters) : CoroutineWorker(appContext, workerParams) {

    override suspend fun getForegroundInfo(): ForegroundInfo = createForegroundInfo()

    private fun createForegroundInfo(): ForegroundInfo {
        val channelId = "video_conversion"
        val manager = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(channelId, "Video conversion", NotificationManager.IMPORTANCE_LOW)
            )
        }
        val notification = androidx.core.app.NotificationCompat.Builder(applicationContext, channelId)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle("Converting video")
            .setContentText("Bad Apple Studio is processing your media.")
            .setOngoing(true)
            .build()
        return ForegroundInfo(1001, notification)
    }

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        setForeground(createForegroundInfo())
        val inputUriString = inputData.getString(KEY_INPUT_URI)
        val isVideo = inputData.getBoolean(KEY_IS_VIDEO, false)
        val fps = inputData.getInt(KEY_FPS, 12)
        val width = inputData.getInt(KEY_WIDTH, 320)
        val height = inputData.getInt(KEY_HEIGHT, 240)
        val rotation = inputData.getFloat(KEY_ROTATION, 0f)
        val zoom = inputData.getFloat(KEY_ZOOM, 1f)
        val panX = inputData.getFloat(KEY_PAN_X, 0f)
        val panY = inputData.getFloat(KEY_PAN_Y, 0f)
        val forSdCard = inputData.getBoolean(KEY_FOR_SD_CARD, false)

        if (inputUriString == null) {
            return@withContext Result.failure(Data.Builder().putString(KEY_ERROR, "No input URI provided").build())
        }

        val inputUri = Uri.parse(inputUriString)
        val context = applicationContext
        
        // FFmpeg needs a seekable file, but a phone video can be much larger
        // than 100 MB. Use a unique directory and verify available storage
        // before copying, rather than allowing cache exhaustion to kill the app.
        val workDir = File(context.cacheDir, "conversion-${UUID.randomUUID()}")
        workDir.mkdirs()
        val inputFile = File(workDir, "input_media")
        val sourceSize = querySize(context, inputUri)
        val copyReserve = 32L * 1024 * 1024
        if (sourceSize != null && sourceSize + copyReserve > workDir.usableSpace) {
            workDir.deleteRecursively()
            return@withContext failure("Not enough free storage to read this ${(sourceSize / MIB)} MB video. Free space and try again.")
        }
        try {
            copyInputWithProgress(context, inputUri, inputFile, sourceSize)
        } catch (e: Exception) {
            workDir.deleteRecursively()
            return@withContext failure("Failed to read input file: ${e.message}")
        }
        
        var effectiveFps = fps
        var effectiveW = width
        var effectiveH = height
        var durationSeconds = 0.0

        // 1.5 Auto-scale if video to fit ~1.7MB SPIFFS limit
        if (isVideo && !forSdCard) {
            val probe = FFprobeKit.getMediaInformation(inputFile.absolutePath)
            val info = probe.mediaInformation
            if (info != null && info.duration != null) {
                try {
                    val duration = info.duration.toDouble()
                    durationSeconds = duration
                    val MAX_SPIFFS_SIZE = 1746534 // ~1.66 MB safe limit
                    val HEADER_OVERHEAD = 16
                    val PER_FRAME_LEN_PREFIX = 4
                    val bytesPerPixel = 2
                    
                    fun estimateSize(w: Int, h: Int, f: Int): Int {
                        val frames = Math.ceil(duration * f).toInt()
                        if (frames <= 0) return 0
                        return HEADER_OVERHEAD + frames * (PER_FRAME_LEN_PREFIX + w * h * bytesPerPixel)
                    }

                    if (estimateSize(effectiveW, effectiveH, effectiveFps) > MAX_SPIFFS_SIZE) {
                        var fitted = false
                        
                        // Try lowering FPS
                        for (tryFps in effectiveFps downTo Math.max(1, effectiveFps / 2)) {
                            if (estimateSize(effectiveW, effectiveH, tryFps) <= MAX_SPIFFS_SIZE) {
                                effectiveFps = tryFps
                                fitted = true
                                break
                            }
                        }
                        
                        // Try reducing resolution
                        if (!fitted) {
                            val halfFps = Math.max(1, effectiveFps / 2)
                            val scales = listOf(2, 4, 5, 8, 10)
                            for (scale in scales) {
                                val testW = width / scale
                                val testH = height / scale
                                if (estimateSize(testW, testH, halfFps) <= MAX_SPIFFS_SIZE) {
                                    effectiveW = testW
                                    effectiveH = testH
                                    effectiveFps = halfFps
                                    fitted = true
                                    break
                                }
                            }
                        }
                        
                        if (!fitted) {
                            return@withContext failure("Video is too long to fit in 1.7MB (SPIFFS). Please insert an SD Card to upload large videos.")
                        }
                    }
                } catch (e: Exception) {
                    android.util.Log.e("ConvertWorker", "Failed to parse duration: ${e.message}")
                }
            }
        } 

        // SD-card conversions also need duration for storage estimates and
        // continuous FFmpeg progress reporting.
        if (isVideo && durationSeconds <= 0.0) {
            durationSeconds = FFprobeKit.getMediaInformation(inputFile.absolutePath)
                .mediaInformation?.duration?.toDoubleOrNull() ?: 0.0
        }

        // 2. Run FFmpeg to convert to RGB565 raw video
        val rawOutputFile = File(workDir, "output.raw")

        val scale = "scale='iw*min($effectiveW/iw\\,$effectiveH/ih)*$zoom':'ih*min($effectiveW/iw\\,$effectiveH/ih)*$zoom'"
        val padW = "max(iw\\,$effectiveW*4)"
        val padH = "max(ih\\,$effectiveH*4)"
        val pad = "pad=$padW:$padH:(ow-iw)/2:(oh-ih)/2:color=black"
        val rot = "rotate=a=${rotation}*PI/180:ow=iw:oh=ih:c=black"
        val cx = "(iw-$effectiveW)/2 - $panX"
        val cy = "(ih-$effectiveH)/2 - $panY"
        val crop = "crop=$effectiveW:$effectiveH:$cx:$cy"
        
        var vfStr = "$scale,$pad,$rot,$crop,format=rgb565le"
        
        if (isVideo) {
            vfStr = "fps=$effectiveFps,$vfStr"
        }

        val ffmpegCommandArgs = if (isVideo) {
            arrayOf("-y", "-i", inputFile.absolutePath, "-vf", vfStr, "-f", "rawvideo", rawOutputFile.absolutePath)
        } else {
            arrayOf("-y", "-i", inputFile.absolutePath, "-vf", vfStr, "-frames:v", "1", "-f", "rawvideo", rawOutputFile.absolutePath)
        }

        try {
            // Raw RGB565 and video.dat coexist briefly while packaging. Check
            // this *before* FFmpeg writes anything so storage pressure turns
            // into an actionable error rather than an Android process death.
            val frameCount = if (isVideo) {
                kotlin.math.ceil(durationSeconds * effectiveFps).toLong()
            } else 1L
            val rawBytes = frameCount * effectiveW.toLong() * effectiveH.toLong() * 2L
            val finalBytes = 16L + frameCount * (4L + effectiveW.toLong() * effectiveH.toLong() * 2L)
            val requiredBytes = inputFile.length() + rawBytes + finalBytes + copyReserve
            if (requiredBytes > workDir.usableSpace) {
                return@withContext failure(
                    "This conversion needs about ${formatMiB(requiredBytes)} of free storage, but only " +
                        "${formatMiB(workDir.usableSpace)} is available. Use a shorter/lower-FPS video or free storage."
                )
            }

            setProgress(progress("Converting frames", 20))
            val session = executeFfmpegWithProgress(ffmpegCommandArgs, durationSeconds)
            if (!ReturnCode.isSuccess(session.returnCode)) {
                return@withContext failure("FFmpeg failed: ${session.logsAsString}")
            }

            // 3. Pack raw RGB565 frames into video.dat
            val finalOutputFile = File(context.cacheDir, "video.dat")
            if (finalOutputFile.exists()) finalOutputFile.delete()
            setProgress(progress("Packing video.dat", 90))
            VideoPackager.packRawRgb565(
                rawOutputFile.absolutePath,
                finalOutputFile.absolutePath,
                effectiveW,
                effectiveH,
                effectiveFps
            ) { completed, total ->
                val packProgress = if (total > 0) completed.toDouble() / total else 1.0
                setProgressAsync(progress("Packing video.dat", (90 + packProgress * 10).toInt()))
            }
            setProgress(progress("Ready to upload", 100))
            Result.success(Data.Builder().putString(KEY_OUTPUT_PATH, finalOutputFile.absolutePath).build())
        } catch (e: Exception) {
            failure("Conversion failed: ${e.message}")
        } finally {
            // Input and uncompressed frames are temporary and can be enormous.
            workDir.deleteRecursively()
        }
    }

    private fun querySize(context: Context, uri: Uri): Long? = try {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getLong(0) else null
        }
    } catch (_: Exception) { null }

    private fun failure(message: String): Result =
        Result.failure(Data.Builder().putString(KEY_ERROR, message).build())

    private fun formatMiB(bytes: Long): String = "%.0f MB".format(bytes.toDouble() / MIB)

    private fun progress(stage: String, percent: Int): Data = Data.Builder()
        .putString(KEY_PROGRESS_STAGE, stage)
        .putInt(KEY_PROGRESS_PERCENT, percent.coerceIn(0, 100))
        .build()

    private suspend fun copyInputWithProgress(context: Context, uri: Uri, destination: File, totalBytes: Long?) {
        context.contentResolver.openInputStream(uri)?.use { input ->
            FileOutputStream(destination).use { output ->
                val buffer = ByteArray(1024 * 1024)
                var copied = 0L
                while (true) {
                    kotlinx.coroutines.currentCoroutineContext().ensureActive()
                    val count = input.read(buffer)
                    if (count < 0) break
                    output.write(buffer, 0, count)
                    copied += count
                    val percent = if (totalBytes != null && totalBytes > 0) (copied * 15 / totalBytes).toInt() else 0
                    setProgress(progress("Reading media", percent))
                }
            }
        } ?: throw IllegalArgumentException("Unable to open the selected media file.")
    }

    private suspend fun executeFfmpegWithProgress(args: Array<String>, durationSeconds: Double): Session =
        suspendCancellableCoroutine { continuation ->
            val session = FFmpegKit.executeWithArgumentsAsync(
                args,
                { completed -> if (continuation.isActive) continuation.resume(completed) },
                null,
                { statistics ->
                    if (durationSeconds > 0.0) {
                        val frameProgress = (statistics.time / (durationSeconds * 1000.0)).coerceIn(0.0, 1.0)
                        // FFmpeg is the bulk of work: map it from 20% to 90%.
                        setProgressAsync(progress("Converting frames", (20 + frameProgress * 70).toInt()))
                    }
                }
            )
            continuation.invokeOnCancellation { FFmpegKit.cancel(session.sessionId) }
        }

    companion object {
        private const val MIB = 1024L * 1024L
        const val KEY_INPUT_URI = "input_uri"
        const val KEY_IS_VIDEO = "is_video"
        const val KEY_FPS = "fps"
        const val KEY_WIDTH = "width"
        const val KEY_HEIGHT = "height"
        const val KEY_ROTATION = "rotation"
        const val KEY_ZOOM = "zoom"
        const val KEY_PAN_X = "pan_x"
        const val KEY_PAN_Y = "pan_y"
        const val KEY_FOR_SD_CARD = "for_sd_card"
        const val KEY_OUTPUT_PATH = "output_path"
        const val KEY_ERROR = "error"
        const val KEY_PROGRESS_STAGE = "progress_stage"
        const val KEY_PROGRESS_PERCENT = "progress_percent"
    }
}

package com.example.badapplestudio

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale

data class ReleaseInfo(
    val version: String,
    val tagName: String,
    val apkUrl: String,
    val releaseNotes: String,
    val apkSize: Long = 0L
)

object AppUpdater {
    private const val LATEST_RELEASE_API =
        "https://api.github.com/repos/Minta1234/bad-apple-studio/releases/latest"

    fun getCurrentVersion(context: Context): String {
        return try {
            val pkgInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                context.packageManager.getPackageInfo(
                    context.packageName,
                    PackageManager.PackageInfoFlags.of(0)
                )
            } else {
                @Suppress("DEPRECATION")
                context.packageManager.getPackageInfo(context.packageName, 0)
            }
            pkgInfo.versionName ?: "0.0.0"
        } catch (_: Exception) {
            "0.0.0"
        }
    }

    fun isNewerVersion(current: String, latest: String): Boolean {
        val curParts = parseVersionParts(current)
        val latParts = parseVersionParts(latest)
        val count = maxOf(curParts.size, latParts.size)
        for (i in 0 until count) {
            val c = curParts.getOrElse(i) { 0 }
            val l = latParts.getOrElse(i) { 0 }
            if (l > c) return true
            if (l < c) return false
        }
        return false
    }

    private fun parseVersionParts(raw: String): List<Int> {
        val cleaned = raw
            .replace(Regex("^(?i)(releasev|release|v)"), "")
            .substringBefore("-")
            .trim()
        return cleaned.split(".")
            .mapNotNull { it.filter(Char::isDigit).toIntOrNull() }
    }

    suspend fun checkForUpdate(context: Context): Result<ReleaseInfo?> = withContext(Dispatchers.IO) {
        var conn: HttpURLConnection? = null
        try {
            conn = (URL(LATEST_RELEASE_API).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                setRequestProperty("Accept", "application/vnd.github+json")
                setRequestProperty("User-Agent", "BadAppleStudio-Android")
                connectTimeout = 10_000
                readTimeout = 10_000
            }
            val code = conn.responseCode
            if (code !in 200..299) {
                return@withContext Result.failure(Exception("GitHub API returned HTTP $code"))
            }

            val body = conn.inputStream.bufferedReader().use { it.readText() }
            val json = JSONObject(body)
            val tagName = json.optString("tag_name", "").ifBlank { json.optString("name", "") }
            val latestVersion = tagName.replace(Regex("^(?i)(releasev|release|v)"), "").trim()
            val releaseNotes = json.optString("body", "").trim()

            val assets = json.optJSONArray("assets")
            var fallbackApkUrl: String? = null
            var fallbackApkSize = 0L
            var preferredApkUrl: String? = null
            var preferredApkSize = 0L
            if (assets != null) {
                for (i in 0 until assets.length()) {
                    val asset = assets.optJSONObject(i) ?: continue
                    val name = asset.optString("name", "")
                    val url = asset.optString("browser_download_url", "")
                    val size = asset.optLong("size", 0L)
                    if (name.endsWith(".apk", ignoreCase = true) && url.isNotBlank()) {
                        if (name.equals("BadAppleStudio.apk", ignoreCase = true)) {
                            preferredApkUrl = url
                            preferredApkSize = size
                            break
                        }
                        if (fallbackApkUrl == null) {
                            fallbackApkUrl = url
                            fallbackApkSize = size
                        }
                    }
                }
            }

            val apkUrl = preferredApkUrl ?: fallbackApkUrl
            val apkSize = if (preferredApkUrl != null) preferredApkSize else fallbackApkSize
            if (apkUrl.isNullOrBlank() || latestVersion.isBlank()) {
                return@withContext Result.success(null)
            }

            val currentVersion = getCurrentVersion(context)
            if (isNewerVersion(currentVersion, latestVersion)) {
                Result.success(
                    ReleaseInfo(
                        version = latestVersion,
                        tagName = tagName,
                        apkUrl = apkUrl,
                        releaseNotes = releaseNotes,
                        apkSize = apkSize
                    )
                )
            } else {
                Result.success(null)
            }
        } catch (e: Exception) {
            Result.failure(e)
        } finally {
            conn?.disconnect()
        }
    }

    suspend fun downloadApk(
        context: Context,
        apkUrl: String,
        expectedSize: Long = 0L,
        onProgress: (Float, String) -> Unit
    ): Result<File> = withContext(Dispatchers.IO) {
        val mainHandler = Handler(Looper.getMainLooper())
        val updatesDir = File(context.cacheDir, "updates").apply { mkdirs() }
        val targetFile = File(updatesDir, "BadAppleStudio-update.apk")
        val tempFile = File(updatesDir, "BadAppleStudio-update.apk.tmp")
        var conn: HttpURLConnection? = null

        try {
            mainHandler.post { onProgress(0f, "Connecting to server...") }
            var currentUrl = apkUrl
            var redirects = 0
            while (true) {
                conn?.disconnect()
                conn = (URL(currentUrl).openConnection() as HttpURLConnection).apply {
                    instanceFollowRedirects = false
                    requestMethod = "GET"
                    setRequestProperty("User-Agent", "BadAppleStudio-Android")
                    setRequestProperty("Accept-Encoding", "identity")
                    connectTimeout = 15_000
                    readTimeout = 30_000
                }
                val code = conn.responseCode
                if (code in 300..399) {
                    val location = conn.getHeaderField("Location")
                        ?: return@withContext Result.failure(Exception("Redirect without Location"))
                    if (++redirects > 5) {
                        return@withContext Result.failure(Exception("Too many redirects"))
                    }
                    currentUrl = URL(URL(currentUrl), location).toString()
                    continue
                }
                if (code !in 200..299) {
                    return@withContext Result.failure(Exception("Download failed: HTTP $code"))
                }
                break
            }

            val connection = conn
            val headerLen = connection.getHeaderField("Content-Length")?.toLongOrNull() ?: -1L
            val totalBytes = when {
                connection.contentLengthLong > 0L -> connection.contentLengthLong
                headerLen > 0L -> headerLen
                expectedSize > 0L -> expectedSize
                else -> -1L
            }
            var downloadedBytes = 0L
            var lastNotifyMs = 0L
            val downloadStartMs = System.currentTimeMillis()

            connection.inputStream.use { input ->
                FileOutputStream(tempFile).use { output ->
                    val buffer = ByteArray(16 * 1024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read == -1) break
                        output.write(buffer, 0, read)
                        downloadedBytes += read

                        val now = System.currentTimeMillis()
                        if (lastNotifyMs == 0L || now - lastNotifyMs >= 100L) {
                            lastNotifyMs = now
                            val progress = if (totalBytes > 0L) {
                                (downloadedBytes.toFloat() / totalBytes.toFloat()).coerceIn(0f, 1f)
                            } else {
                                0f
                            }
                            val dlMb = downloadedBytes / (1024.0 * 1024.0)
                            val elapsedSec = ((now - downloadStartMs) / 1000.0).coerceAtLeast(0.1)
                            val speedMbps = dlMb / elapsedSec
                            val label = if (totalBytes > 0L) {
                                val totMb = totalBytes / (1024.0 * 1024.0)
                                String.format(Locale.US, "%.1f / %.1f MB (%.1f MB/s)", dlMb, totMb, speedMbps)
                            } else {
                                String.format(Locale.US, "%.1f MB (%.1f MB/s)", dlMb, speedMbps)
                            }
                            mainHandler.post { onProgress(progress, label) }
                        }
                    }
                    output.flush()
                }
            }

            if (targetFile.exists()) targetFile.delete()
            if (!tempFile.renameTo(targetFile)) {
                tempFile.copyTo(targetFile, overwrite = true)
                tempFile.delete()
            }
            mainHandler.post { onProgress(1f, "Download complete") }
            Result.success(targetFile)
        } catch (e: Exception) {
            tempFile.delete()
            Result.failure(e)
        } finally {
            conn?.disconnect()
        }
    }

    fun installApk(context: Context, apkFile: File): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !context.packageManager.canRequestPackageInstalls()
        ) {
            val intent = Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:${context.packageName}")
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            return false
        }

        val uri = FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            apkFile
        )
        val installIntent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(installIntent)
        return true
    }
}

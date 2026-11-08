package com.example.badapplestudio

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll

import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import androidx.work.*
import coil.compose.AsyncImage
import coil.decode.VideoFrameDecoder
import coil.request.ImageRequest
import com.example.badapplestudio.theme.BadAppleStudioTheme
import com.example.badapplestudio.theme.GradientStart
import com.example.badapplestudio.theme.GradientEnd
import kotlinx.coroutines.launch
import java.io.File

class MainActivity : ComponentActivity() {

    private lateinit var bleManager: BleUploadManager
    private var selectedBoard by mutableStateOf(SupportedBoards.boards[0])
    private var selectedUri by mutableStateOf<Uri?>(null)
    private var isVideo by mutableStateOf(false)
    private var selectedRotation by mutableStateOf(0f)
    private var zoom by mutableStateOf(1f)
    private var panX by mutableStateOf(0f)
    private var panY by mutableStateOf(0f)
    private var isConverting by mutableStateOf(false)
    private var conversionPath by mutableStateOf<String?>(null)
    private var conversionProgress by mutableStateOf(0f)
    private var conversionStage by mutableStateOf("Preparing conversion…")
    
    private var scannedDevices = mutableStateListOf<BluetoothDevice>()
    private var isScanning by mutableStateOf(false)
    private var isUploading by mutableStateOf(false)
    private var uploadProgress by mutableStateOf(0f)
    private var uploadSpeed by mutableStateOf("")
    private var connectedDevice by mutableStateOf<BluetoothDevice?>(null)

    @OptIn(ExperimentalMaterial3Api::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        bleManager = BleUploadManager(this)

        setContent {
            BadAppleStudioTheme {
                Surface(
                    modifier = Modifier.fillMaxSize()
                ) {
                    val scrollState = rememberScrollState()

                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .background(Brush.linearGradient(colors = listOf(GradientStart, GradientEnd)))
                            .verticalScroll(scrollState)
                            .padding(16.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        Text(
                            text = "Bad Apple Studio",
                            style = MaterialTheme.typography.headlineMedium,
                            fontWeight = FontWeight.Bold,
                            fontFamily = FontFamily.Monospace,
                            color = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.padding(top = 8.dp, bottom = 4.dp)
                        )

                        // 1. Board Selector
                        BoardSelectorCard(
                            selectedBoard = selectedBoard,
                            onBoardSelected = { 
                                selectedBoard = it 
                                conversionPath = null
                            }
                        )

                        // 2. Media Picker + Preview
                        MediaPickerCard(
                            selectedUri = selectedUri,
                            isVideo = isVideo,
                            selectedBoard = selectedBoard,
                            rotation = selectedRotation,
                            zoom = zoom,
                            panX = panX,
                            panY = panY,
                            onMediaPicked = { uri, isVid ->
                                cancelConversion(showToast = false)
                                selectedUri = uri
                                isVideo = isVid
                                conversionPath = null
                            }
                        )

                        var isForSdCard by remember { mutableStateOf(false) }

                        // 3. Transform & Convert
                        AnimatedVisibility(visible = selectedUri != null && conversionPath == null) {
                            ConvertCard(
                                selectedUri = selectedUri,
                                isVideo = isVideo,
                                selectedBoard = selectedBoard,
                                isConverting = isConverting,
                                rotation = selectedRotation,
                                zoom = zoom,
                                panX = panX,
                                panY = panY,
                                isForSdCard = isForSdCard,
                                conversionProgress = conversionProgress,
                                conversionStage = conversionStage,
                                onRotationChanged = { selectedRotation = it },
                                onZoomChanged = { zoom = it },
                                onPanXChanged = { panX = it },
                                onPanYChanged = { panY = it },
                                onIsForSdCardChanged = { isForSdCard = it },
                                onReset = {
                                    selectedRotation = 0f
                                    zoom = 1f
                                    panX = 0f
                                    panY = 0f
                                },
                                onCancelConvert = { cancelConversion() },
                                onConvert = { startConversion(isForSdCard) }
                            )
                        }

                         // 4. Connect to Board
                         AnimatedVisibility(visible = conversionPath != null) {
                             ConnectCard(
                                 isScanning = isScanning,
                                 scannedDevices = scannedDevices,
                                 connectedDevice = connectedDevice,
                                 onScan = {
                                     if (hasBlePermissions()) startScan()
                                     else requestPermissionsLauncher.launch(getBlePermissions())
                                 },
                                 onCancelScan = {
                                     isScanning = false
                                 },
                                 onSelectDevice = { device ->
                                     connectedDevice = device
                                 }
                             )
                         }

                         // 5. Upload
                         AnimatedVisibility(visible = conversionPath != null) {
                             UploadCard(
                                 isUploading = isUploading,
                                 uploadProgress = uploadProgress,
                                 uploadSpeed = uploadSpeed,
                                 canUpload = connectedDevice != null,
                                 uploadLabel = "📤 Upload via Bluetooth",
                                 onUpload = {
                                     connectedDevice?.let { startUpload(it) }
                                 }
                             )
                         }


                        // Bottom spacer so content doesn't hide behind nav bar
                        Spacer(modifier = Modifier.height(32.dp))
                    }
                }
            }
        }
    }

    private val requestPermissionsLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        if (permissions.entries.all { it.value }) startScan()
        else Toast.makeText(this, "Bluetooth permissions required", Toast.LENGTH_SHORT).show()
    }

    private var convertWorkId: java.util.UUID? = null

    private fun startConversion(isForSdCard: Boolean) {
        if (selectedUri == null) return
        isConverting = true
        conversionProgress = 0f
        conversionStage = "Preparing conversion…"

        val fps = if (isVideo) 12 else 1

        val inputData = Data.Builder()
            .putString(ConvertWorker.KEY_INPUT_URI, selectedUri.toString())
            .putBoolean(ConvertWorker.KEY_IS_VIDEO, isVideo)
            .putInt(ConvertWorker.KEY_FPS, fps)
            .putInt(ConvertWorker.KEY_WIDTH, selectedBoard.width)
            .putInt(ConvertWorker.KEY_HEIGHT, selectedBoard.height)
            .putFloat(ConvertWorker.KEY_ROTATION, selectedRotation)
            .putFloat(ConvertWorker.KEY_ZOOM, zoom)
            .putFloat(ConvertWorker.KEY_PAN_X, panX)
            .putFloat(ConvertWorker.KEY_PAN_Y, panY)
            .putBoolean(ConvertWorker.KEY_FOR_SD_CARD, isForSdCard)
            .build()

        val request = OneTimeWorkRequestBuilder<ConvertWorker>()
            .setInputData(inputData)
            .build()

        convertWorkId = request.id
        WorkManager.getInstance(this).enqueue(request)

        WorkManager.getInstance(this).getWorkInfoByIdLiveData(request.id).observe(this) { workInfo ->
            if (workInfo != null && request.id != convertWorkId) return@observe
            if (workInfo != null) {
                conversionProgress = workInfo.progress.getInt(ConvertWorker.KEY_PROGRESS_PERCENT, 0) / 100f
                conversionStage = workInfo.progress.getString(ConvertWorker.KEY_PROGRESS_STAGE) ?: conversionStage
            }
            if (workInfo != null && workInfo.state.isFinished) {
                isConverting = false
                if (workInfo.state == WorkInfo.State.SUCCEEDED) {
                    conversionPath = workInfo.outputData.getString(ConvertWorker.KEY_OUTPUT_PATH)
                    Toast.makeText(this, "Converted successfully!", Toast.LENGTH_SHORT).show()
                } else if (workInfo.state == WorkInfo.State.CANCELLED) {
                    Toast.makeText(this, "Conversion cancelled", Toast.LENGTH_SHORT).show()
                } else {
                    val error = workInfo.outputData.getString(ConvertWorker.KEY_ERROR)
                    Toast.makeText(this, "Conversion failed: $error", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun cancelConversion(showToast: Boolean = true) {
        val wasConverting = isConverting
        convertWorkId?.let {
            WorkManager.getInstance(this).cancelWorkById(it)
        }
        convertWorkId = null
        isConverting = false
        if (showToast && wasConverting) {
            Toast.makeText(this, "Conversion cancelled", Toast.LENGTH_SHORT).show()
        }
    }

    private fun startScan() {
        isScanning = true
        scannedDevices.clear()
        
        lifecycleScope.launch {
            bleManager.scanDevices().collect { device ->
                if (!scannedDevices.contains(device)) {
                    scannedDevices.add(device)
                }
            }
            // Flow completes when timeout is reached
            isScanning = false
        }
    }

    private fun startUpload(device: BluetoothDevice) {
        val path = conversionPath ?: return
        val datFile = File(path)
        if (!datFile.exists()) {
            Toast.makeText(this, "File not found", Toast.LENGTH_SHORT).show()
            return
        }

        isScanning = false
        isUploading = true
        uploadProgress = 0f
        uploadSpeed = ""

        bleManager.connectAndUpload(
            device = device,
            datFile = datFile,
            onProgress = { progress, speedStr ->
                runOnUiThread { 
                    uploadProgress = progress
                    uploadSpeed = speedStr
                }
            },
            onComplete = { success, error ->
                runOnUiThread {
                    isUploading = false
                    if (success) {
                        Toast.makeText(this@MainActivity, "Upload complete!", Toast.LENGTH_SHORT).show()
                    } else {
                        Toast.makeText(this@MainActivity, "Upload failed: $error", Toast.LENGTH_LONG).show()
                    }
                }
            }
        )
    }

    private fun hasBlePermissions(): Boolean {
        return getBlePermissions().all {
            ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
        }
    }

    private fun getBlePermissions(): Array<String> {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            arrayOf(
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_CONNECT,
                Manifest.permission.ACCESS_FINE_LOCATION
            )
        } else {
            arrayOf(
                Manifest.permission.ACCESS_FINE_LOCATION
            )
        }
    }
}

@Composable
fun StepCard(title: String, content: @Composable ColumnScope.() -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
        border = BorderStroke(1.dp, Color(0x1A000000))
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("▶ ", color = MaterialTheme.colorScheme.primary, fontSize = MaterialTheme.typography.titleMedium.fontSize)
                Text(
                    text = title.uppercase(), 
                    style = MaterialTheme.typography.titleMedium,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.primary,
                    fontWeight = FontWeight.Bold
                )
            }
            content()
        }
    }
}

@Composable
fun BoardSelectorCard(selectedBoard: BoardConfig, onBoardSelected: (BoardConfig) -> Unit) {
    var expanded by remember { mutableStateOf(false) }

    StepCard("Step 1: Select CYD Board") {
        Box {
            OutlinedButton(
                onClick = { expanded = true },
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(selectedBoard.description)
                Spacer(modifier = Modifier.weight(1f))
                Text("▼")
            }
            DropdownMenu(
                expanded = expanded,
                onDismissRequest = { expanded = false },
                modifier = Modifier.fillMaxWidth(0.85f).background(MaterialTheme.colorScheme.surface)
            ) {
                SupportedBoards.boards.forEach { board ->
                    DropdownMenuItem(
                        text = { 
                            Column {
                                Text(board.id, fontWeight = FontWeight.Bold)
                                Text(board.description, style = MaterialTheme.typography.bodySmall, color = Color.Gray)
                            }
                        },
                        onClick = {
                            onBoardSelected(board)
                            expanded = false
                        }
                    )
                }
            }
        }
    }
}

@Composable
fun MediaPickerCard(
    selectedUri: Uri?, 
    isVideo: Boolean,
    selectedBoard: BoardConfig,
    rotation: Float,
    zoom: Float,
    panX: Float,
    panY: Float,
    onMediaPicked: (Uri?, Boolean) -> Unit
) {
    val context = LocalContext.current
    val mediaPicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenDocument()
    ) { uri: Uri? ->
        if (uri != null) {
            val type = context.contentResolver.getType(uri)
            val isVid = type?.startsWith("video") == true
            onMediaPicked(uri, isVid)
        }
    }

    StepCard("Step 2: Select Media") {

        Button(
            onClick = { mediaPicker.launch(arrayOf("image/*", "video/*")) },
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.buttonColors(containerColor = if (selectedUri != null) Color(0xFF4CAF50) else MaterialTheme.colorScheme.primary)
        ) {
            Text(if (selectedUri == null) "Choose Image/Video" else "Change Media")
        }
    }
}

@Composable
fun TransformControl(
    label: String,
    value: Float,
    valueRange: ClosedFloatingPointRange<Float>,
    onValueChange: (Float) -> Unit,
    formatStr: String = "%.0f"
) {
    var textValue by remember(value) { mutableStateOf(String.format(formatStr, value)) }
    
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(label, style = MaterialTheme.typography.labelMedium, modifier = Modifier.width(80.dp))
        Slider(
            value = value,
            onValueChange = { onValueChange(it) },
            valueRange = valueRange,
            modifier = Modifier.weight(1f)
        )
        OutlinedTextField(
            value = textValue,
            onValueChange = { 
                textValue = it
                it.toFloatOrNull()?.let { num ->
                    if (num in valueRange) onValueChange(num)
                }
            },
            modifier = Modifier.width(72.dp),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            singleLine = true,
            textStyle = LocalTextStyle.current.copy(textAlign = TextAlign.End, fontSize = MaterialTheme.typography.bodySmall.fontSize)
        )
    }
}

@Composable
fun ConvertCard(
    selectedUri: Uri?,
    isVideo: Boolean,
    selectedBoard: BoardConfig,
    isConverting: Boolean, 
    rotation: Float,
    zoom: Float,
    panX: Float,
    panY: Float,
    isForSdCard: Boolean,
    conversionProgress: Float,
    conversionStage: String,
    onRotationChanged: (Float) -> Unit, 
    onZoomChanged: (Float) -> Unit,
    onPanXChanged: (Float) -> Unit,
    onPanYChanged: (Float) -> Unit,
    onIsForSdCardChanged: (Boolean) -> Unit,
    onReset: () -> Unit,
    onCancelConvert: () -> Unit,
    onConvert: () -> Unit
) {
    StepCard("Step 3: Screen Rotation & Zoom") {
        
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(Color(0xFFE1F5FE))
                .padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            if (selectedUri != null) {
                val context = LocalContext.current
                val imageRequest = ImageRequest.Builder(context)
                    .data(selectedUri)
                    // Decode only a small preview frame. Decoding a full 4K
                    // frame for a 320px board preview can exhaust Android RAM.
                    .size(640, 640)
                    .apply {
                        if (isVideo) {
                            decoderFactory(VideoFrameDecoder.Factory())
                        }
                    }
                    .build()

                val boardW = selectedBoard.width
                val boardH = selectedBoard.height
                val aspectRatio = boardW.toFloat() / boardH.toFloat()

                Box(
                    modifier = Modifier
                        .padding(16.dp)
                        .width(boardW.dp)
                        .height(boardH.dp)
                        .shadow(4.dp, RoundedCornerShape(4.dp))
                        .clip(RoundedCornerShape(4.dp))
                        .background(Color.Black),
                    contentAlignment = Alignment.Center
                ) {
                    AsyncImage(
                        model = imageRequest,
                        contentDescription = "Media Preview",
                        contentScale = ContentScale.Fit,
                        modifier = Modifier
                            .fillMaxSize()
                            .graphicsLayer(
                                rotationZ = rotation,
                                scaleX = zoom,
                                scaleY = zoom,
                                translationX = panX,
                                translationY = panY
                            )
                    )
                }
            }

            Spacer(modifier = Modifier.height(16.dp))

            Column(modifier = Modifier.fillMaxWidth(0.9f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                TransformControl("Rotate", rotation, 0f..360f, onRotationChanged)
                TransformControl("Zoom", zoom, 0.5f..5f, onZoomChanged, "%.1f")
                TransformControl("Pan X", panX, -300f..300f, onPanXChanged)
                TransformControl("Pan Y", panY, -300f..300f, onPanYChanged)
            }

            Spacer(modifier = Modifier.height(16.dp))

            OutlinedButton(
                onClick = onReset,
                border = BorderStroke(1.dp, Color(0xFF29B6F6)),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Color(0xFF29B6F6))
            ) {
                Text("Reset")
            }

            Spacer(modifier = Modifier.height(16.dp))

            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Text(
                    text = "Save to SD Card (No Size Limit)",
                    style = MaterialTheme.typography.bodyMedium
                )
                androidx.compose.material3.Switch(
                    checked = isForSdCard,
                    onCheckedChange = { onIsForSdCardChanged(it) }
                )
            }

            Spacer(modifier = Modifier.height(16.dp))

            Text(
                text = "Drag the image to pan. Use sliders to rotate and zoom.",
                style = MaterialTheme.typography.labelSmall,
                color = Color.Gray,
                textAlign = TextAlign.Center
            )
        }

        Spacer(modifier = Modifier.height(8.dp))

        if (isConverting) {
            Button(
                onClick = onCancelConvert,
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFFCE4EC), contentColor = Color(0xFFE91E63)),
                modifier = Modifier.fillMaxWidth()
            ) {
                Text("✕ Cancel Conversion")
            }
            Spacer(modifier = Modifier.height(4.dp))
            LinearProgressIndicator(
                progress = { conversionProgress },
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(4.dp))
            )
            Text("$conversionStage ${(conversionProgress * 100).toInt()}%", style = MaterialTheme.typography.labelSmall, color = Color.Gray)
        } else {
            Button(
                onClick = onConvert,
                modifier = Modifier.fillMaxWidth()
            ) {
                Text("Convert to RGB565")
            }
        }
    }
}

@SuppressLint("MissingPermission")
@Composable
fun ConnectCard(
    isScanning: Boolean,
    scannedDevices: List<BluetoothDevice>,
    connectedDevice: BluetoothDevice?,
    onScan: () -> Unit,
    onCancelScan: () -> Unit,
    onSelectDevice: (BluetoothDevice) -> Unit
) {
    StepCard("Step 4: Connect to Board") {
        Text(
            text = "Click scan to find your ESP32 board. If multiple boards are found, select one from the list below.",
            style = MaterialTheme.typography.bodySmall,
            color = Color.Gray
        )

        Spacer(modifier = Modifier.height(8.dp))

        if (isScanning) {
            Button(
                onClick = onCancelScan,
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFFCE4EC), contentColor = Color(0xFFE91E63)),
                modifier = Modifier.fillMaxWidth()
            ) {
                Text("✕ Cancel Scan")
            }
        } else {
            Button(
                onClick = onScan,
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFFCE4EC), contentColor = Color(0xFFE91E63)),
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(if (scannedDevices.isEmpty()) "Scan for Devices" else "Rescan")
            }
        }

        if (scannedDevices.isNotEmpty()) {
            Spacer(modifier = Modifier.height(16.dp))
            Text("SELECT A DEVICE:", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, color = Color.Gray)
            
            scannedDevices.forEach { device ->
                val isSelected = connectedDevice == device
                Card(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                    colors = CardDefaults.cardColors(containerColor = if (isSelected) Color(0xFFE1F5FE) else MaterialTheme.colorScheme.surfaceVariant),
                    border = BorderStroke(1.dp, if (isSelected) Color(0xFF29B6F6) else Color.Transparent)
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            // Using a simple text as icon placeholder if bluetooth icon isn't imported
                            Text("📡", style = MaterialTheme.typography.headlineSmall)
                            Column {
                                Text(device.name ?: "Unknown Device", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.bodyMedium)
                                Text(device.address, style = MaterialTheme.typography.bodySmall, color = Color.Gray)
                            }
                        }
                        Button(
                            onClick = { onSelectDevice(device) },
                            colors = ButtonDefaults.buttonColors(containerColor = if (isSelected) Color(0xFF81D4FA) else Color(0xFF29B6F6))
                        ) {
                            Text(if (isSelected) "Connected" else "Connect", color = Color.White)
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun UploadCard(
    isUploading: Boolean,
    uploadProgress: Float,
    uploadSpeed: String,
    canUpload: Boolean,
    uploadLabel: String = "📤 Upload via Bluetooth",
    onUpload: () -> Unit
) {
    StepCard("Step 5: Upload") {
        Button(
            onClick = onUpload,
            enabled = canUpload && !isUploading,
            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF81D4FA)),
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(uploadLabel, color = Color.White)
        }

        if (isUploading) {
            Spacer(modifier = Modifier.height(8.dp))
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("Uploading...", style = MaterialTheme.typography.bodyMedium)
                if (uploadSpeed.isNotEmpty()) {
                    Text(uploadSpeed, style = MaterialTheme.typography.bodyMedium, color = Color.Gray)
                }
            }
            LinearProgressIndicator(
                progress = { uploadProgress },
                modifier = Modifier.fillMaxWidth().height(8.dp).clip(RoundedCornerShape(4.dp)),
                color = Color(0xFF29B6F6)
            )
            Text("${(uploadProgress * 100).toInt()}%", style = MaterialTheme.typography.labelLarge)
        }
    }
}

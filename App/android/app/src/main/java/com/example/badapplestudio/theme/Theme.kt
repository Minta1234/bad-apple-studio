package com.example.badapplestudio.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.graphics.Color

private val LightColorScheme = lightColorScheme(
    primary = CyanAccent,
    secondary = PinkAccent,
    tertiary = CyanLight,
    background = Color.Transparent, // Will use gradient in Surface
    surface = SurfaceColor,
    onPrimary = Color.White,
    onSecondary = Color.White,
    onTertiary = TextColor,
    onBackground = TextColor,
    onSurface = TextColor,
)

@Composable
fun BadAppleStudioTheme(
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = LightColorScheme, 
        typography = Typography, 
        content = content
    )
}

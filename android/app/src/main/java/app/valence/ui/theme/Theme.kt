package app.valence.ui.theme

import android.os.Build
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.core.graphics.ColorUtils

/** Valence green, the accent when nothing is playing (matches the desktop's default accent). */
val ValenceAccent = Color(0xFF1ED760)

private fun dark(black: Boolean) = darkColorScheme(
    primary = ValenceAccent,
    onPrimary = Color(0xFF00210B),
    primaryContainer = Color(0xFF0E5A2B),
    onPrimaryContainer = Color(0xFFB7F5C8),
    secondary = Color(0xFFB3B3B3),
    onSecondary = Color(0xFF121212),
    secondaryContainer = Color(0xFF2A2A2A),
    onSecondaryContainer = Color(0xFFEDEDED),
    tertiary = Color(0xFF9AD0FF),
    background = if (black) Color.Black else Color(0xFF121212),
    onBackground = Color(0xFFF1F1F1),
    surface = if (black) Color.Black else Color(0xFF121212),
    onSurface = Color(0xFFF1F1F1),
    surfaceVariant = if (black) Color(0xFF141414) else Color(0xFF242424),
    onSurfaceVariant = Color(0xFFB3B3B3),
    surfaceContainerLowest = if (black) Color.Black else Color(0xFF0C0C0C),
    surfaceContainerLow = if (black) Color(0xFF0A0A0A) else Color(0xFF181818),
    surfaceContainer = if (black) Color(0xFF101010) else Color(0xFF1C1C1C),
    surfaceContainerHigh = if (black) Color(0xFF171717) else Color(0xFF232323),
    surfaceContainerHighest = if (black) Color(0xFF1F1F1F) else Color(0xFF2C2C2C),
    outline = Color(0xFF5E5E5E),
    outlineVariant = Color(0xFF333333),
)

private val light = lightColorScheme(
    primary = Color(0xFF0B7A36),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFB7F5C8),
    onPrimaryContainer = Color(0xFF00210B),
    secondary = Color(0xFF555555),
    secondaryContainer = Color(0xFFE6E6E6),
    onSecondaryContainer = Color(0xFF1A1A1A),
    background = Color(0xFFFAFAFA),
    surface = Color(0xFFFAFAFA),
    surfaceVariant = Color(0xFFEDEDED),
    onSurfaceVariant = Color(0xFF555555),
    surfaceContainerLow = Color(0xFFF4F4F4),
    surfaceContainer = Color(0xFFEEEEEE),
    surfaceContainerHigh = Color(0xFFE8E8E8),
    surfaceContainerHighest = Color(0xFFE2E2E2),
    outlineVariant = Color(0xFFDDDDDD),
)

/**
 * The accent follows the playing album's art (like the desktop): its colour is pushed toward a
 * lightness that reads well on this scheme's background, then used for primary and its container.
 */
fun ColorScheme.tinted(art: Color?, isDark: Boolean): ColorScheme {
    if (art == null) return this
    val hsl = FloatArray(3)
    ColorUtils.colorToHSL(art.toArgb(), hsl)
    if (hsl[1] < 0.12f) return this // greyscale art: keep the default accent
    val accent = Color(ColorUtils.HSLToColor(floatArrayOf(hsl[0], hsl[1].coerceIn(0.45f, 0.9f), if (isDark) 0.62f else 0.38f)))
    val container = Color(ColorUtils.HSLToColor(floatArrayOf(hsl[0], hsl[1].coerceIn(0.3f, 0.6f), if (isDark) 0.22f else 0.86f)))
    val onAccent = if (ColorUtils.calculateLuminance(accent.toArgb()) > 0.4) Color(0xFF111111) else Color.White
    return copy(
        primary = accent,
        onPrimary = onAccent,
        primaryContainer = container,
        onPrimaryContainer = if (isDark) Color(0xFFF1F1F1) else Color(0xFF111111),
        tertiary = accent,
    )
}

private val type = Typography().let { t ->
    t.copy(
        headlineLarge = t.headlineLarge.copy(fontWeight = FontWeight.Bold),
        headlineMedium = t.headlineMedium.copy(fontWeight = FontWeight.Bold),
        headlineSmall = t.headlineSmall.copy(fontWeight = FontWeight.Bold),
        titleLarge = t.titleLarge.copy(fontWeight = FontWeight.Bold),
        titleMedium = t.titleMedium.copy(fontWeight = FontWeight.SemiBold),
        labelSmall = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.3.sp),
    )
}

@Composable
fun ValenceTheme(mode: String, dynamic: Boolean, art: Color?, content: @Composable () -> Unit) {
    val isDark = when (mode) {
        "light" -> false
        "dark", "black" -> true
        else -> isSystemInDarkTheme()
    }
    val ctx = LocalContext.current
    val base = when {
        dynamic && Build.VERSION.SDK_INT >= 31 -> if (isDark) dynamicDarkColorScheme(ctx).let { if (mode == "black") it.copy(background = Color.Black, surface = Color.Black) else it } else dynamicLightColorScheme(ctx)
        isDark -> dark(mode == "black")
        else -> light
    }
    val target = if (dynamic) base else base.tinted(art, isDark)
    val primary by animateColorAsState(target.primary, tween(600), label = "primary")
    val primaryContainer by animateColorAsState(target.primaryContainer, tween(600), label = "primaryContainer")
    val scheme = target.copy(primary = primary, primaryContainer = primaryContainer, tertiary = primary)
    MaterialTheme(colorScheme = scheme, typography = type) {
        // Screens drawn outside a Surface (Now Playing's gradient) would otherwise get black text and icons.
        CompositionLocalProvider(LocalContentColor provides scheme.onBackground, content = content)
    }
}

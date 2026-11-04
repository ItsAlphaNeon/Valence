package app.valence.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.core.graphics.ColorUtils

/**
 * Musicolet's flat look: one background, a slightly lighter tab bar, grey dialogs, thin grey
 * outlines and a single accent colour picked in Settings (not taken from the album art).
 */
@Immutable
data class Palette(
    val dark: Boolean,
    val bg: Color,
    val bar: Color,
    val dialog: Color,
    val divider: Color,
    val outline: Color,
    val text: Color,
    val text2: Color,
    val text3: Color,
    val thumb: Color,
    val artBg: Color,
    val accent: Color,
    val onAccent: Color,
)

/** Accent presets offered in Settings (Musicolet's default green first). */
val ACCENTS = listOf(
    0xFF65FFA0, 0xFF64FFDA, 0xFF4DD0E1, 0xFF82B1FF, 0xFF8C9EFF, 0xFFB388FF,
    0xFFFF80AB, 0xFFFF8A80, 0xFFFFAB40, 0xFFFFD740, 0xFFC6FF00, 0xFFE0E0E0,
).map { Color(it) }

const val DEFAULT_ACCENT = "#65FFA0"

fun parseAccent(hex: String): Color = runCatching { Color(android.graphics.Color.parseColor(hex)) }.getOrDefault(ACCENTS[0])

fun Color.toHex(): String = String.format("#%06X", toArgb() and 0xFFFFFF)

private fun accentFor(c: Color, dark: Boolean): Color {
    if (dark) return c
    // On a light background the bright accents are unreadable: same hue, darker.
    val hsl = FloatArray(3)
    ColorUtils.colorToHSL(c.toArgb(), hsl)
    if (hsl[2] <= 0.42f) return c
    hsl[2] = 0.36f
    return Color(ColorUtils.HSLToColor(hsl))
}

fun palette(mode: String, systemDark: Boolean, accentHex: String): Palette {
    val dark = when (mode) {
        "light" -> false
        "dark", "black" -> true
        else -> systemDark
    }
    val accent = accentFor(parseAccent(accentHex), dark)
    val onAccent = if (ColorUtils.calculateLuminance(accent.toArgb()) > 0.4) Color(0xFF111111) else Color.White
    return when {
        !dark -> Palette(
            dark = false, bg = Color(0xFFFAFAFA), bar = Color(0xFFEEEEEE), dialog = Color(0xFFFFFFFF),
            divider = Color(0xFFDADADA), outline = Color(0xFFCCCCCC), text = Color(0xFF1A1A1A), text2 = Color(0xFF5F5F5F),
            text3 = Color(0xFF8A8A8A), thumb = Color(0xFFC4C4C4), artBg = Color(0xFFE3E3E3), accent = accent, onAccent = onAccent,
        )
        mode == "black" -> Palette(
            dark = true, bg = Color.Black, bar = Color(0xFF0F0F0F), dialog = Color(0xFF1E1E1E),
            divider = Color(0xFF2C2C2C), outline = Color(0xFF353535), text = Color.White, text2 = Color(0xFFB0B0B0),
            text3 = Color(0xFF8A8A8A), thumb = Color(0xFF3A3A3A), artBg = Color(0xFF1A1A1A), accent = accent, onAccent = onAccent,
        )
        else -> Palette(
            dark = true, bg = Color(0xFF181818), bar = Color(0xFF212121), dialog = Color(0xFF323232),
            divider = Color(0xFF424242), outline = Color(0xFF474747), text = Color.White, text2 = Color(0xFFB3B3B3),
            text3 = Color(0xFF909090), thumb = Color(0xFF424242), artBg = Color(0xFF2A2A2A), accent = accent, onAccent = onAccent,
        )
    }
}

val LocalPalette = staticCompositionLocalOf { palette("dark", true, DEFAULT_ACCENT) }

private val type = Typography().let { t ->
    t.copy(
        titleLarge = t.titleLarge.copy(fontSize = 20.sp, fontWeight = FontWeight.Bold),
        titleMedium = t.titleMedium.copy(fontWeight = FontWeight.Medium),
        labelSmall = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.3.sp),
    )
}

@Composable
fun ValenceTheme(mode: String, accent: String, content: @Composable () -> Unit) {
    val systemDark = isSystemInDarkTheme()
    val p = remember(mode, systemDark, accent) { palette(mode, systemDark, accent) }
    val scheme = remember(p) {
        if (p.dark) darkColorScheme(
            primary = p.accent, onPrimary = p.onAccent, primaryContainer = p.accent.copy(alpha = 0.25f).compositeOver(p.dialog),
            onPrimaryContainer = p.text, secondary = p.text2, onSecondary = p.bg, secondaryContainer = p.dialog, onSecondaryContainer = p.text,
            tertiary = p.accent, background = p.bg, onBackground = p.text, surface = p.bg, onSurface = p.text,
            surfaceVariant = p.bar, onSurfaceVariant = p.text2, surfaceContainerLowest = p.bg, surfaceContainerLow = p.bar,
            surfaceContainer = p.bar, surfaceContainerHigh = p.dialog, surfaceContainerHighest = p.dialog,
            outline = p.outline, outlineVariant = p.divider, inverseSurface = Color(0xFFE6E6E6), inverseOnSurface = Color(0xFF1A1A1A),
        ) else lightColorScheme(
            primary = p.accent, onPrimary = p.onAccent, primaryContainer = p.accent.copy(alpha = 0.18f).compositeOver(p.dialog),
            onPrimaryContainer = p.text, secondary = p.text2, onSecondary = p.bg, secondaryContainer = p.bar, onSecondaryContainer = p.text,
            tertiary = p.accent, background = p.bg, onBackground = p.text, surface = p.bg, onSurface = p.text,
            surfaceVariant = p.bar, onSurfaceVariant = p.text2, surfaceContainerLowest = p.bg, surfaceContainerLow = p.bar,
            surfaceContainer = p.bar, surfaceContainerHigh = p.dialog, surfaceContainerHighest = p.dialog,
            outline = p.outline, outlineVariant = p.divider,
        )
    }
    MaterialTheme(colorScheme = scheme, typography = type) {
        CompositionLocalProvider(LocalPalette provides p, LocalContentColor provides p.text, content = content)
    }
}

private fun Color.compositeOver(bg: Color): Color {
    val a = alpha
    return Color(red * a + bg.red * (1 - a), green * a + bg.green * (1 - a), blue * a + bg.blue * (1 - a), 1f)
}

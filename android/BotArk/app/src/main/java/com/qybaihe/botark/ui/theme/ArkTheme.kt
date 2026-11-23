package com.qybaihe.botark.ui.theme

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.qybaihe.botark.R
import com.qybaihe.botark.model.ConnectionStatus
import com.qybaihe.botark.model.PlatformId

/**
 * Custom bundled Plus Jakarta Sans + JetBrains Mono font families.
 */
val ArkSansFamily = FontFamily(
    Font(R.font.plusjakartasans_regular, FontWeight.Normal),
    Font(R.font.plusjakartasans_medium, FontWeight.Medium),
    Font(R.font.plusjakartasans_semibold, FontWeight.SemiBold),
    Font(R.font.plusjakartasans_bold, FontWeight.Bold)
)

val ArkMonoFamily = FontFamily(
    Font(R.font.jetbrainsmono_medium, FontWeight.Medium)
)

data class ArkPalette(
    val canvas: Color,
    val surface: Color,
    val subtleFill: Color,
    val hairline: Color,
    val textPrimary: Color,
    val textSecondary: Color,
    val textTertiary: Color,
    val ink: Color,
    val onInk: Color,
    val obsidian: Color,
    val porcelain: Color,
    val accent: Color,
    val emerald: Color,
    val amber: Color,
    val rose: Color,
    val prismBlue: Color,
    val prismViolet: Color,
    val prismAmber: Color,
    val prismTeal: Color
)

private val LightPalette = ArkPalette(
    canvas = Color(0xFFFAF8F5),
    surface = Color(0xFFFFFFFF),
    subtleFill = Color(0x0C1C1917),
    hairline = Color(0x131C1917),
    textPrimary = Color(0xFF14151A),
    textSecondary = Color(0xFF6B7280),
    textTertiary = Color(0xFF9CA3AF),
    ink = Color(0xFF14151A),
    onInk = Color(0xFFFCFBF9),
    obsidian = Color(0xFF16171D),
    porcelain = Color(0xFFFBF9F6),
    accent = Color(0xFF3B5BFF),
    emerald = Color(0xFF10B981),
    amber = Color(0xFFF59E0B),
    rose = Color(0xFFEF4444),
    prismBlue = Color(0xFF4085FF),
    prismViolet = Color(0xFF8F52FA),
    prismAmber = Color(0xFFFA9E33),
    prismTeal = Color(0xFF1FC2AD)
)

private val DarkPalette = ArkPalette(
    canvas = Color(0xFF0D0E12),
    surface = Color(0xFF161820),
    subtleFill = Color(0x11FFFFFF),
    hairline = Color(0x17FFFFFF),
    textPrimary = Color(0xFFF8F7F4),
    textSecondary = Color(0xFF9CA3AF),
    textTertiary = Color(0xFF6B7280),
    ink = Color(0xFFF8F7F4),
    onInk = Color(0xFF14151A),
    obsidian = Color(0xFF16171D),
    porcelain = Color(0xFFFBF9F6),
    accent = Color(0xFF5B7BFF),
    emerald = Color(0xFF10B981),
    amber = Color(0xFFF59E0B),
    rose = Color(0xFFF87171),
    prismBlue = Color(0xFF4085FF),
    prismViolet = Color(0xFF8F52FA),
    prismAmber = Color(0xFFFA9E33),
    prismTeal = Color(0xFF1FC2AD)
)

val LocalArkPalette = staticCompositionLocalOf { LightPalette }

object ArkColors {
    val current: ArkPalette
        @Composable get() = LocalArkPalette.current
}

fun PlatformId.brandColor(): Color = when (this) {
    PlatformId.GROK -> Color(0xFF292E3D)
    PlatformId.META_MUSE -> Color(0xFF1C73F5)
    PlatformId.DOT -> Color(0xFF0D997A)
    PlatformId.HARK -> Color(0xFFE86629)
    PlatformId.HERMES -> Color(0xFF784FF0)
    PlatformId.ANTIGRAVITY -> Color(0xFF4285F4)
    PlatformId.CUE -> Color(0xFF429DFA)
}

fun ConnectionStatus.dotColor(): Color = when (this) {
    ConnectionStatus.ONLINE -> Color(0xFF10B981)
    ConnectionStatus.BUSY -> Color(0xFF3B5BFF)
    ConnectionStatus.ATTENTION -> Color(0xFFF59E0B)
    ConnectionStatus.OFFLINE -> Color(0xFF9CA3AF)
    ConnectionStatus.ERROR -> Color(0xFFEF4444)
}

@Composable
fun LivingPulseDot(
    color: Color,
    size: Dp = 6.5.dp,
    animated: Boolean = true
) {
    val transition = rememberInfiniteTransition(label = "pulse")
    val scale by transition.animateFloat(
        initialValue = 0.7f,
        targetValue = 1.65f,
        animationSpec = infiniteRepeatable(
            animation = tween(1700),
            repeatMode = RepeatMode.Restart
        ),
        label = "scale"
    )
    val alpha by transition.animateFloat(
        initialValue = 0.48f,
        targetValue = 0f,
        animationSpec = infiniteRepeatable(
            animation = tween(1700),
            repeatMode = RepeatMode.Restart
        ),
        label = "alpha"
    )

    Box(contentAlignment = Alignment.Center, modifier = Modifier.size(size * 1.8f)) {
        if (animated) {
            Box(
                modifier = Modifier
                    .size(size)
                    .scale(scale)
                    .clip(CircleShape)
                    .background(color.copy(alpha = alpha))
            )
        }
        Box(
            modifier = Modifier
                .size(size)
                .clip(CircleShape)
                .background(color)
        )
    }
}

private val DefaultTypography = Typography()
private val ArkTypography = Typography(
    displayLarge = DefaultTypography.displayLarge.copy(fontFamily = ArkSansFamily),
    displayMedium = DefaultTypography.displayMedium.copy(fontFamily = ArkSansFamily),
    displaySmall = DefaultTypography.displaySmall.copy(fontFamily = ArkSansFamily),
    headlineLarge = DefaultTypography.headlineLarge.copy(fontFamily = ArkSansFamily),
    headlineMedium = DefaultTypography.headlineMedium.copy(fontFamily = ArkSansFamily),
    headlineSmall = DefaultTypography.headlineSmall.copy(fontFamily = ArkSansFamily),
    titleLarge = DefaultTypography.titleLarge.copy(fontFamily = ArkSansFamily),
    titleMedium = DefaultTypography.titleMedium.copy(fontFamily = ArkSansFamily),
    titleSmall = DefaultTypography.titleSmall.copy(fontFamily = ArkSansFamily),
    bodyLarge = DefaultTypography.bodyLarge.copy(fontFamily = ArkSansFamily),
    bodyMedium = DefaultTypography.bodyMedium.copy(fontFamily = ArkSansFamily),
    bodySmall = DefaultTypography.bodySmall.copy(fontFamily = ArkSansFamily),
    labelLarge = DefaultTypography.labelLarge.copy(fontFamily = ArkSansFamily),
    labelMedium = DefaultTypography.labelMedium.copy(fontFamily = ArkSansFamily),
    labelSmall = DefaultTypography.labelSmall.copy(fontFamily = ArkSansFamily)
)

@Composable
fun BotArkTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    val palette = if (darkTheme) DarkPalette else LightPalette
    val colorScheme = if (darkTheme) {
        darkColorScheme(
            primary = palette.ink,
            background = palette.canvas,
            surface = palette.surface,
            onPrimary = palette.onInk,
            onBackground = palette.textPrimary,
            onSurface = palette.textPrimary
        )
    } else {
        lightColorScheme(
            primary = palette.ink,
            background = palette.canvas,
            surface = palette.surface,
            onPrimary = palette.onInk,
            onBackground = palette.textPrimary,
            onSurface = palette.textPrimary
        )
    }

    CompositionLocalProvider(LocalArkPalette provides palette) {
        MaterialTheme(
            colorScheme = colorScheme,
            typography = ArkTypography,
            content = content
        )
    }
}

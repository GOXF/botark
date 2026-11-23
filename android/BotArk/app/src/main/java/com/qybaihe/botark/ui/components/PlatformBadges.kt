package com.qybaihe.botark.ui.components

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.qybaihe.botark.R
import com.qybaihe.botark.model.ConnectionStatus
import com.qybaihe.botark.model.PlatformId
import com.qybaihe.botark.model.SyncedBot
import com.qybaihe.botark.ui.theme.ArkColors
import com.qybaihe.botark.ui.theme.ArkSansFamily
import com.qybaihe.botark.ui.theme.brandColor
import com.qybaihe.botark.ui.theme.dotColor

fun PlatformId.drawableRes(): Int = when (this) {
    PlatformId.META_MUSE -> R.drawable.ic_platform_muse
    PlatformId.GROK -> R.drawable.ic_platform_grok
    PlatformId.DOT -> R.drawable.ic_platform_dot
    PlatformId.HARK -> R.drawable.ic_platform_hark
    PlatformId.HERMES -> R.drawable.ic_platform_hermes
    PlatformId.ANTIGRAVITY -> R.drawable.ic_platform_antigravity
    PlatformId.CUE -> R.drawable.ic_platform_cue
}

@Composable
fun PlatformIcon(platform: PlatformId, size: Dp = 18.dp, modifier: Modifier = Modifier) {
    Image(
        painter = painterResource(platform.drawableRes()),
        contentDescription = platform.displayName,
        contentScale = ContentScale.Fit,
        modifier = modifier
            .size(size)
            .clip(RoundedCornerShape(size * 0.26f))
    )
}

@Composable
fun BotAvatar(
    bot: SyncedBot,
    status: ConnectionStatus,
    size: Dp = 40.dp
) {
    val palette = ArkColors.current
    val shape = RoundedCornerShape(size * 0.32f)
    val decoded = remember(bot.avatar) { decodeBase64Image(bot.avatar) }

    Box(modifier = Modifier.size(size)) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .size(size)
                .clip(shape)
                .background(
                    Brush.linearGradient(
                        listOf(
                            bot.platformId.brandColor().copy(alpha = 0.14f),
                            bot.platformId.brandColor().copy(alpha = 0.04f)
                        )
                    )
                )
                .border(0.8.dp, palette.hairline, shape)
        ) {
            when {
                decoded != null -> Image(
                    bitmap = decoded,
                    contentDescription = bot.name,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.size(size)
                )
                !bot.emoji.isNullOrEmpty() -> Text(
                    text = bot.emoji,
                    fontSize = (size.value * 0.45f).sp
                )
                else -> Image(
                    painter = painterResource(bot.platformId.drawableRes()),
                    contentDescription = bot.name,
                    contentScale = ContentScale.Fit,
                    modifier = Modifier
                        .size(size)
                        .padding(size * 0.18f)
                )
            }
        }

        val dotSize = (size * 0.22f).coerceAtLeast(8.5.dp)
        Box(
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .offset(x = 1.5.dp, y = 1.5.dp)
                .size(dotSize)
                .clip(CircleShape)
                .background(status.dotColor())
                .border(1.8.dp, palette.surface, CircleShape)
        )
    }
}

@Composable
fun PlatformBadgePill(platform: PlatformId) {
    val brand = platform.brandColor()
    Text(
        text = platform.shortLabel,
        fontSize = 10.sp,
        lineHeight = 13.sp,
        fontFamily = ArkSansFamily,
        fontWeight = FontWeight.SemiBold,
        color = brand,
        maxLines = 1,
        modifier = Modifier
            .clip(CircleShape)
            .background(brand.copy(alpha = 0.10f))
            .padding(horizontal = 6.5.dp, vertical = 2.5.dp)
    )
}

fun decodeBase64Image(raw: String?): ImageBitmap? {
    if (raw.isNullOrBlank()) return null
    if (!raw.startsWith("data:") && raw.length < 512 && (raw.contains('/') || raw.contains('.'))) {
        return null
    }
    val part = raw.substringAfter(",", raw)
    return runCatching {
        val bytes = Base64.decode(part, Base64.DEFAULT)
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
    }.getOrNull()
}

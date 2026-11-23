package com.qybaihe.botark.ui.screens

import android.content.ContentResolver
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import android.widget.MediaController
import android.widget.VideoView
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.InsertDriveFile
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowLeft
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.ArrowUpward
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.EditNote
import androidx.compose.material.icons.rounded.Image
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Shield
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material.icons.rounded.Terminal
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.qybaihe.botark.model.ConnectionStatus
import com.qybaihe.botark.model.MobileOutboundAttachment
import com.qybaihe.botark.model.PendingApprovalItem
import com.qybaihe.botark.model.SyncedBot
import com.qybaihe.botark.model.SyncedMediaPart
import com.qybaihe.botark.model.SyncedMessage
import com.qybaihe.botark.model.SyncedToolCall
import com.qybaihe.botark.ui.components.BotAvatar
import com.qybaihe.botark.ui.components.PlatformBadgePill
import com.qybaihe.botark.ui.components.PlatformIcon
import com.qybaihe.botark.ui.components.decodeBase64Image
import com.qybaihe.botark.ui.theme.ArkColors
import com.qybaihe.botark.ui.theme.ArkMonoFamily
import com.qybaihe.botark.ui.theme.ArkSansFamily
import com.qybaihe.botark.ui.theme.LivingPulseDot
import com.qybaihe.botark.ui.theme.dotColor
import com.qybaihe.botark.viewmodel.BotArkUiState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File
import kotlin.math.max

private const val MAX_VIDEO_ATTACHMENT_BYTES = 8L * 1024L * 1024L

@Composable
fun ChatScreen(
    state: BotArkUiState,
    botId: String,
    onBack: () -> Unit,
    onSend: (SyncedBot, String, List<MobileOutboundAttachment>) -> Unit,
    onStop: (SyncedBot) -> Unit,
    onNewSession: (SyncedBot) -> Unit,
    onDecideApproval: (PendingApprovalItem, String) -> Unit
) {
    val palette = ArkColors.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val bot = state.snapshot.bots.firstOrNull { it.id == botId }
    if (bot == null) {
        Box(Modifier.fillMaxSize().background(palette.canvas), contentAlignment = Alignment.Center) {
            Text("智能体已移除", fontSize = 14.sp, color = palette.textSecondary)
        }
        return
    }

    val messages = state.snapshot.messages[botId].orEmpty()
    val botApprovals = state.pendingApprovals.filter { it.accountId == bot.activeAccountId }
    val isTyping = state.typingByBotId[bot.id] == true
    val canSend = state.canSend(bot)
    val canAttach = state.connectionState.isBridgeConnected
    val botStatus = state.status(bot)
    var draft by remember { mutableStateOf("") }
    var pendingAttachments by remember(botId) { mutableStateOf<List<MobileOutboundAttachment>>(emptyList()) }
    var attachError by remember(botId) { mutableStateOf<String?>(null) }
    var previewImage by remember { mutableStateOf<ImageBitmap?>(null) }
    var previewVideoFile by remember { mutableStateOf<File?>(null) }
    val listState = rememberLazyListState()

    val mediaPicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.PickMultipleVisualMedia(4)
    ) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        attachError = null
        scope.launch {
            val loaded = mutableListOf<MobileOutboundAttachment>()
            var errorMsg: String? = null
            withContext(Dispatchers.IO) {
                for (uri in uris) {
                    val res = encodeVisualUri(context, uri)
                    res.onSuccess { loaded.add(it) }
                    res.onFailure { errorMsg = it.message ?: "无法读取附件" }
                }
            }
            if (loaded.isNotEmpty()) {
                pendingAttachments = (pendingAttachments + loaded).take(4)
            }
            if (errorMsg != null) {
                attachError = errorMsg
            }
        }
    }

    LaunchedEffect(messages.size, messages.lastOrNull()?.text, messages.lastOrNull()?.media?.size, isTyping) {
        if (messages.isNotEmpty()) {
            listState.animateScrollToItem(messages.lastIndex)
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(palette.canvas)
            .imePadding()
    ) {
        // Minimal Studio Header
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 9.dp)
        ) {
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .size(34.dp)
                    .clip(CircleShape)
                    .background(palette.surface)
                    .border(0.8.dp, palette.hairline, CircleShape)
                    .clickable(onClick = onBack)
            ) {
                Icon(
                    imageVector = Icons.AutoMirrored.Rounded.KeyboardArrowLeft,
                    contentDescription = "返回",
                    tint = palette.textPrimary,
                    modifier = Modifier.size(20.dp)
                )
            }
            Spacer(Modifier.width(10.dp))
            PlatformIcon(platform = bot.platformId, size = 22.dp)
            Spacer(Modifier.width(8.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = bot.name,
                    fontSize = 14.5.sp,
                    fontFamily = ArkSansFamily,
                    fontWeight = FontWeight.SemiBold,
                    color = palette.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(3.dp)
                ) {
                    LivingPulseDot(
                        color = botStatus.dotColor(),
                        size = 5.5.dp,
                        animated = botStatus == ConnectionStatus.ONLINE || botStatus == ConnectionStatus.BUSY || botStatus == ConnectionStatus.ATTENTION
                    )
                    Text(
                        text = state.shortTransportLabel(bot),
                        fontSize = 10.5.sp,
                        color = palette.textSecondary
                    )
                }
            }
            if (bot.platformId.supportsQuickNewSession) {
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .size(34.dp)
                        .clip(CircleShape)
                        .background(palette.surface)
                        .border(0.8.dp, palette.hairline, CircleShape)
                        .clickable(enabled = canSend) { onNewSession(bot) }
                ) {
                    Icon(
                        imageVector = Icons.Rounded.EditNote,
                        contentDescription = "新对话",
                        tint = if (canSend) palette.textPrimary else palette.textTertiary,
                        modifier = Modifier.size(18.dp)
                    )
                }
            }
        }

        // Floating editorial approval card(s)
        if (botApprovals.isNotEmpty()) {
            Column(
                verticalArrangement = Arrangement.spacedBy(6.dp),
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 4.dp)
            ) {
                botApprovals.forEach { item ->
                    InlineApprovalCard(item = item, onDecide = { onDecideApproval(item, it) })
                }
            }
        }

        // Messages canvas
        LazyColumn(
            state = listState,
            contentPadding = PaddingValues(horizontal = 14.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier.weight(1f)
        ) {
            if (messages.isEmpty()) {
                item {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = 72.dp)
                    ) {
                        BotAvatar(bot = bot, status = botStatus, size = 52.dp)
                        Text(bot.name, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, color = palette.textPrimary)
                        PlatformBadgePill(bot.platformId)
                    }
                }
            } else {
                items(messages, key = { it.id }) { msg ->
                    MessageBubbleRow(
                        message = msg,
                        onOpenImage = { previewImage = it },
                        onOpenVideo = { part ->
                            scope.launch {
                                val file = withContext(Dispatchers.IO) { materializeVideoFile(context, part) }
                                if (file != null) {
                                    previewVideoFile = file
                                } else {
                                    attachError = "视频正在同步，请稍候重试"
                                }
                            }
                        }
                    )
                }
            }

            if (isTyping) {
                item(key = "typing") {
                    Text(
                        text = "正在生成...",
                        fontSize = 12.sp,
                        color = palette.textSecondary,
                        modifier = Modifier
                            .clip(CircleShape)
                            .background(palette.surface)
                            .border(0.8.dp, palette.hairline, CircleShape)
                            .padding(horizontal = 12.dp, vertical = 8.dp)
                    )
                }
            }
        }

        if (attachError != null) {
            Text(
                text = attachError!!,
                fontSize = 11.5.sp,
                color = palette.rose,
                modifier = Modifier.padding(horizontal = 18.dp, vertical = 2.dp)
            )
        }

        if (pendingAttachments.isNotEmpty()) {
            LazyRow(
                contentPadding = PaddingValues(horizontal = 14.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                itemsIndexed(pendingAttachments) { idx, att ->
                    PendingAttachmentChip(
                        attachment = att,
                        onRemove = {
                            pendingAttachments = pendingAttachments.filterIndexed { i, _ -> i != idx }
                        }
                    )
                }
            }
        }

        // Floating Tactile Capsule Composer
        val composerShape = RoundedCornerShape(24.dp)
        Row(
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 10.dp)
                .shadow(8.dp, composerShape, ambientColor = Color.Black.copy(alpha = 0.06f))
                .clip(composerShape)
                .background(palette.surface)
                .border(0.9.dp, palette.hairline, composerShape)
                .padding(start = 6.dp, end = 5.dp, top = 5.dp, bottom = 5.dp)
        ) {
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .size(34.dp)
                    .clip(CircleShape)
                    .background(palette.subtleFill)
                    .clickable(enabled = canSend) {
                        if (!canAttach) {
                            attachError = "发送图片或视频请先连接电脑端"
                        } else {
                            attachError = null
                            mediaPicker.launch(
                                PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)
                            )
                        }
                    }
            ) {
                Icon(
                    imageVector = Icons.Rounded.Add,
                    contentDescription = "添加图片或视频",
                    tint = if (canAttach) palette.textPrimary else palette.textTertiary,
                    modifier = Modifier.size(18.dp)
                )
            }

            Box(
                contentAlignment = Alignment.CenterStart,
                modifier = Modifier
                    .weight(1f)
                    .padding(horizontal = 4.dp, vertical = 7.dp)
            ) {
                if (draft.isEmpty()) {
                    Text(
                        text = if (canSend) "给 ${bot.name} 发消息..." else "离线只读",
                        fontSize = 14.sp,
                        color = palette.textTertiary
                    )
                }
                BasicTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    enabled = canSend,
                    maxLines = 5,
                    textStyle = TextStyle(
                        fontSize = 14.sp,
                        fontFamily = ArkSansFamily,
                        color = palette.textPrimary,
                        lineHeight = 19.sp
                    ),
                    cursorBrush = SolidColor(palette.ink),
                    modifier = Modifier.fillMaxWidth()
                )
            }

            if (isTyping) {
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .size(34.dp)
                        .clip(CircleShape)
                        .background(palette.rose)
                        .clickable { onStop(bot) }
                ) {
                    Icon(Icons.Rounded.Stop, contentDescription = "停止", tint = Color.White, modifier = Modifier.size(15.dp))
                }
            } else {
                val ready = canSend && (draft.trim().isNotEmpty() || pendingAttachments.isNotEmpty())
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .size(34.dp)
                        .clip(CircleShape)
                        .background(if (ready) palette.ink else palette.subtleFill)
                        .clickable(enabled = ready) {
                            val t = draft.trim()
                            val atts = pendingAttachments
                            draft = ""
                            pendingAttachments = emptyList()
                            attachError = null
                            onSend(bot, t, atts)
                        }
                ) {
                    Icon(
                        imageVector = Icons.Rounded.ArrowUpward,
                        contentDescription = "发送",
                        tint = if (ready) palette.onInk else palette.textTertiary,
                        modifier = Modifier.size(16.dp)
                    )
                }
            }
        }
    }

    if (previewImage != null) {
        Dialog(
            onDismissRequest = { previewImage = null },
            properties = DialogProperties(usePlatformDefaultWidth = false)
        ) {
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color.Black.copy(alpha = 0.92f))
                    .clickable { previewImage = null }
            ) {
                Image(
                    bitmap = previewImage!!,
                    contentDescription = "图片预览",
                    contentScale = ContentScale.Fit,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp)
                )
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(20.dp)
                        .size(36.dp)
                        .clip(CircleShape)
                        .background(Color.White.copy(alpha = 0.16f))
                        .clickable { previewImage = null }
                ) {
                    Icon(Icons.Rounded.Close, contentDescription = "关闭", tint = Color.White, modifier = Modifier.size(18.dp))
                }
            }
        }
    }

    if (previewVideoFile != null) {
        val file = previewVideoFile!!
        Dialog(
            onDismissRequest = { previewVideoFile = null },
            properties = DialogProperties(usePlatformDefaultWidth = false)
        ) {
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color.Black.copy(alpha = 0.94f))
            ) {
                AndroidView(
                    factory = { ctx ->
                        VideoView(ctx).apply {
                            val controller = MediaController(ctx)
                            controller.setAnchorView(this)
                            setMediaController(controller)
                            setVideoPath(file.absolutePath)
                            setOnPreparedListener { mp ->
                                mp.isLooping = false
                                start()
                            }
                        }
                    },
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 520.dp)
                )
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(20.dp)
                        .size(36.dp)
                        .clip(CircleShape)
                        .background(Color.White.copy(alpha = 0.16f))
                        .clickable { previewVideoFile = null }
                ) {
                    Icon(Icons.Rounded.Close, contentDescription = "关闭", tint = Color.White, modifier = Modifier.size(18.dp))
                }
            }
        }
    }
}

@Composable
private fun PendingAttachmentChip(
    attachment: MobileOutboundAttachment,
    onRemove: () -> Unit
) {
    val palette = ArkColors.current
    val thumb = remember(attachment.dataUrl) {
        if (attachment.mimeType.startsWith("image/")) decodeBase64Image(attachment.dataUrl) else null
    }
    Box(
        modifier = Modifier
            .size(62.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(palette.surface)
            .border(0.8.dp, palette.hairline, RoundedCornerShape(14.dp))
    ) {
        if (thumb != null) {
            Image(
                bitmap = thumb,
                contentDescription = attachment.name,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize()
            )
        } else {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
                modifier = Modifier.fillMaxSize().padding(4.dp)
            ) {
                Icon(
                    imageVector = Icons.Rounded.PlayArrow,
                    contentDescription = null,
                    tint = palette.textPrimary,
                    modifier = Modifier.size(20.dp)
                )
                Text(
                    text = attachment.name,
                    fontSize = 9.sp,
                    color = palette.textSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(3.dp)
                .size(18.dp)
                .clip(CircleShape)
                .background(Color.Black.copy(alpha = 0.65f))
                .clickable(onClick = onRemove)
        ) {
            Icon(Icons.Rounded.Close, contentDescription = "移除", tint = Color.White, modifier = Modifier.size(11.dp))
        }
    }
}

@Composable
private fun MessageBubbleRow(
    message: SyncedMessage,
    onOpenImage: (ImageBitmap) -> Unit,
    onOpenVideo: (SyncedMediaPart) -> Unit
) {
    val palette = ArkColors.current
    Row(
        horizontalArrangement = if (message.isUser) Arrangement.End else Arrangement.Start,
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(
            horizontalAlignment = if (message.isUser) Alignment.End else Alignment.Start,
            verticalArrangement = Arrangement.spacedBy(6.dp),
            modifier = Modifier.widthIn(max = 314.dp)
        ) {
            if (!message.tools.isNullOrEmpty()) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    message.tools.forEach { ToolCallPill(it) }
                }
            }

            if (!message.media.isNullOrEmpty()) {
                message.media.forEach { part ->
                    val lowerPath = part.path.lowercase()
                    val isVideoPart = part.kind == "video" ||
                        part.mimeType?.startsWith("video/") == true ||
                        lowerPath.startsWith("data:video/") ||
                        lowerPath.endsWith(".mp4") ||
                        lowerPath.endsWith(".mov") ||
                        lowerPath.endsWith(".webm")
                    when {
                        part.kind == "image" || (!isVideoPart && lowerPath.startsWith("data:image/")) -> {
                            val bmp = remember(part.path) { decodeBase64Image(part.path) }
                            if (bmp != null) {
                                Image(
                                    bitmap = bmp,
                                    contentDescription = part.name,
                                    contentScale = ContentScale.Fit,
                                    modifier = Modifier
                                        .widthIn(max = 232.dp)
                                        .clip(RoundedCornerShape(14.dp))
                                        .border(0.8.dp, palette.hairline, RoundedCornerShape(14.dp))
                                        .clickable { onOpenImage(bmp) }
                                )
                            } else {
                                val syncing = !part.path.startsWith("data:")
                                MediaCardPill(
                                    title = part.name ?: part.path.substringAfterLast('/'),
                                    subtitle = if (syncing) "正在从工作区同步图片..." else "图片附件",
                                    isSyncing = syncing,
                                    isVideo = false,
                                    onClick = null
                                )
                            }
                        }
                        isVideoPart -> {
                            val ready = part.path.startsWith("data:video/")
                            MediaCardPill(
                                title = part.name ?: part.path.substringAfterLast('/'),
                                subtitle = if (ready) "点击播放视频" else "正在同步视频...",
                                isSyncing = !ready,
                                isVideo = true,
                                onClick = if (ready) ({ onOpenVideo(part) }) else null
                            )
                        }
                        else -> {
                            MediaCardPill(
                                title = part.name ?: part.path.substringAfterLast('/'),
                                subtitle = part.mimeType ?: "文件附件",
                                isSyncing = false,
                                isVideo = false,
                                onClick = null
                            )
                        }
                    }
                }
            }

            if (message.text.isNotEmpty()) {
                val bubbleShape = RoundedCornerShape(
                    topStart = 18.dp,
                    topEnd = 18.dp,
                    bottomStart = if (message.isUser) 18.dp else 6.dp,
                    bottomEnd = if (message.isUser) 6.dp else 18.dp
                )
                val formatted = remember(message.text) { renderInlineBold(message.text) }
                Text(
                    text = formatted,
                    fontSize = 13.8.sp,
                    fontFamily = ArkSansFamily,
                    lineHeight = 20.5.sp,
                    color = if (message.isUser) palette.onInk else palette.textPrimary,
                    modifier = Modifier
                        .shadow(4.dp, bubbleShape, ambientColor = Color.Black.copy(alpha = 0.06f))
                        .clip(bubbleShape)
                        .background(if (message.isUser) palette.ink else palette.surface)
                        .then(
                            if (message.isUser) Modifier else Modifier.border(0.8.dp, palette.hairline, bubbleShape)
                        )
                        .padding(horizontal = 13.dp, vertical = 10.dp)
                )
            }

            if (!message.error.isNullOrEmpty()) {
                Text(text = message.error, fontSize = 11.sp, color = palette.rose)
            } else if (message.isUser && message.delivery == "sending") {
                Text("发送中", fontSize = 10.sp, fontFamily = ArkMonoFamily, color = palette.textTertiary)
            }
        }
    }
}

@Composable
private fun MediaCardPill(
    title: String,
    subtitle: String,
    isSyncing: Boolean,
    isVideo: Boolean,
    onClick: (() -> Unit)?
) {
    val palette = ArkColors.current
    val shape = RoundedCornerShape(14.dp)
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(9.dp),
        modifier = Modifier
            .widthIn(max = 240.dp)
            .clip(shape)
            .background(palette.surface)
            .border(0.8.dp, palette.hairline, shape)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 11.dp, vertical = 8.5.dp)
    ) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .size(30.dp)
                .clip(CircleShape)
                .background(if (isVideo) palette.ink else palette.subtleFill)
        ) {
            when {
                isSyncing -> CircularProgressIndicator(
                    strokeWidth = 1.6.dp,
                    color = if (isVideo) palette.onInk else palette.accent,
                    modifier = Modifier.size(14.dp)
                )
                isVideo -> Icon(
                    imageVector = Icons.Rounded.PlayArrow,
                    contentDescription = null,
                    tint = palette.onInk,
                    modifier = Modifier.size(17.dp)
                )
                subtitle.contains("图片") -> Icon(
                    imageVector = Icons.Rounded.Image,
                    contentDescription = null,
                    tint = palette.textSecondary,
                    modifier = Modifier.size(15.dp)
                )
                else -> Icon(
                    imageVector = Icons.AutoMirrored.Rounded.InsertDriveFile,
                    contentDescription = null,
                    tint = palette.textSecondary,
                    modifier = Modifier.size(15.dp)
                )
            }
        }
        Column(modifier = Modifier.weight(1f, fill = false)) {
            Text(
                text = title.ifBlank { "媒体附件" },
                fontSize = 12.sp,
                fontFamily = ArkSansFamily,
                fontWeight = FontWeight.Medium,
                color = palette.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            Text(
                text = subtitle,
                fontSize = 10.5.sp,
                color = palette.textSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
    }
}

private fun encodeVisualUri(context: Context, uri: Uri): Result<MobileOutboundAttachment> = runCatching {
    val cr = context.contentResolver
    val mime = cr.getType(uri)?.lowercase()?.trim().orEmpty().ifBlank { "image/jpeg" }
    val (rawName, rawSize) = queryDisplayMeta(cr, uri)

    if (mime.startsWith("video/")) {
        if (rawSize > MAX_VIDEO_ATTACHMENT_BYTES) {
            throw IllegalArgumentException("视频超过 8MB 限制，请裁剪后再发")
        }
        val bytes = cr.openInputStream(uri)?.use { it.readBytes() }
            ?: throw IllegalArgumentException("无法读取视频文件")
        if (bytes.size > MAX_VIDEO_ATTACHMENT_BYTES) {
            throw IllegalArgumentException("视频超过 8MB 限制，请裁剪后再发")
        }
        val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
        val ext = mime.substringAfter('/').substringBefore(';').ifBlank { "mp4" }
        val finalName = rawName ?: "video_${System.currentTimeMillis()}.$ext"
        return@runCatching MobileOutboundAttachment(
            name = finalName,
            mimeType = mime,
            dataUrl = "data:$mime;base64,$b64",
            size = bytes.size.toLong()
        )
    }

    val rawBytes = cr.openInputStream(uri)?.use { it.readBytes() }
        ?: throw IllegalArgumentException("无法读取图片文件")
    val decoded = BitmapFactory.decodeByteArray(rawBytes, 0, rawBytes.size)
        ?: throw IllegalArgumentException("不支持的图片格式")

    val maxDim = max(decoded.width, decoded.height)
    val targetBitmap = if (maxDim > 1600) {
        val ratio = 1600f / maxDim.toFloat()
        val w = (decoded.width * ratio).toInt().coerceAtLeast(1)
        val h = (decoded.height * ratio).toInt().coerceAtLeast(1)
        Bitmap.createScaledBitmap(decoded, w, h, true)
    } else {
        decoded
    }

    val out = ByteArrayOutputStream()
    val outMime: String
    val outExt: String
    if (mime == "image/png" && rawBytes.size <= 1_400_000 && targetBitmap === decoded) {
        out.write(rawBytes)
        outMime = "image/png"
        outExt = "png"
    } else {
        targetBitmap.compress(Bitmap.CompressFormat.JPEG, 86, out)
        outMime = "image/jpeg"
        outExt = "jpg"
    }
    if (targetBitmap !== decoded) targetBitmap.recycle()
    decoded.recycle()

    val encodedBytes = out.toByteArray()
    val b64 = Base64.encodeToString(encodedBytes, Base64.NO_WRAP)
    val baseName = rawName?.substringBeforeLast('.')?.takeIf { it.isNotBlank() } ?: "photo_${System.currentTimeMillis()}"
    MobileOutboundAttachment(
        name = "$baseName.$outExt",
        mimeType = outMime,
        dataUrl = "data:$outMime;base64,$b64",
        size = encodedBytes.size.toLong()
    )
}

private fun queryDisplayMeta(cr: ContentResolver, uri: Uri): Pair<String?, Long> {
    var name: String? = null
    var size = 0L
    runCatching {
        cr.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                val nameIdx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (nameIdx >= 0 && !c.isNull(nameIdx)) name = c.getString(nameIdx)
                val sizeIdx = c.getColumnIndex(OpenableColumns.SIZE)
                if (sizeIdx >= 0 && !c.isNull(sizeIdx)) size = c.getLong(sizeIdx)
            }
        }
    }
    return name to size
}

private fun materializeVideoFile(context: Context, part: SyncedMediaPart): File? {
    if (!part.path.startsWith("data:")) return null
    val commaIdx = part.path.indexOf(',')
    if (commaIdx <= 0) return null
    val header = part.path.substring(5, commaIdx)
    val mime = header.substringBefore(';').lowercase()
    val ext = when {
        mime.contains("webm") -> "webm"
        mime.contains("quicktime") || mime.contains("mov") -> "mov"
        else -> "mp4"
    }
    val hash = part.path.hashCode().toUInt().toString(16)
    val file = File(context.cacheDir, "botark_vid_$hash.$ext")
    if (file.exists() && file.length() > 0L) return file
    return runCatching {
        val bytes = Base64.decode(part.path.substring(commaIdx + 1), Base64.DEFAULT)
        file.writeBytes(bytes)
        file
    }.getOrNull()
}

private fun renderInlineBold(raw: String): AnnotatedString = buildAnnotatedString {
    val parts = raw.split("**")
    parts.forEachIndexed { index, part ->
        if (index % 2 == 1) {
            withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(part) }
        } else {
            append(part)
        }
    }
}

@Composable
private fun ToolCallPill(tool: SyncedToolCall) {
    val palette = ArkColors.current
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        modifier = Modifier
            .clip(CircleShape)
            .background(palette.surface)
            .border(0.8.dp, palette.hairline, CircleShape)
            .padding(horizontal = 9.dp, vertical = 4.5.dp)
    ) {
        when (tool.status) {
            "running" -> CircularProgressIndicator(
                strokeWidth = 1.6.dp,
                color = palette.accent,
                modifier = Modifier.size(11.dp)
            )
            "completed" -> Icon(
                Icons.Rounded.CheckCircle,
                contentDescription = null,
                tint = palette.emerald,
                modifier = Modifier.size(12.dp)
            )
            "errored", "failed" -> Icon(
                Icons.Rounded.Close,
                contentDescription = null,
                tint = palette.rose,
                modifier = Modifier.size(12.dp)
            )
            else -> Icon(
                Icons.Rounded.Terminal,
                contentDescription = null,
                tint = palette.textSecondary,
                modifier = Modifier.size(11.dp)
            )
        }
        Text(
            text = tool.name,
            fontSize = 10.5.sp,
            fontFamily = ArkMonoFamily,
            color = palette.textPrimary
        )
        if (!tool.summary.isNullOrBlank()) {
            Text(
                text = tool.summary,
                fontSize = 11.sp,
                color = palette.textSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
    }
}

@Composable
private fun InlineApprovalCard(
    item: PendingApprovalItem,
    onDecide: (String) -> Unit
) {
    val palette = ArkColors.current
    val shape = RoundedCornerShape(16.dp)

    Column(
        verticalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier
            .fillMaxWidth()
            .shadow(6.dp, shape, ambientColor = palette.amber.copy(alpha = 0.14f))
            .clip(shape)
            .background(palette.surface)
            .border(1.dp, palette.amber.copy(alpha = 0.45f), shape)
            .padding(12.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(Icons.Rounded.Shield, contentDescription = null, tint = palette.amber, modifier = Modifier.size(14.dp))
            Text(
                text = item.approval.title,
                fontSize = 12.5.sp,
                fontFamily = ArkSansFamily,
                fontWeight = FontWeight.SemiBold,
                color = palette.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
        if (!item.approval.detail.isNullOrBlank()) {
            Text(
                text = item.approval.detail,
                fontSize = 10.5.sp,
                lineHeight = 15.sp,
                fontFamily = ArkMonoFamily,
                color = palette.textSecondary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(7.dp), modifier = Modifier.fillMaxWidth()) {
            ApprovalActionPill("允许", palette.ink, palette.onInk) { onDecide("allow_once") }
            ApprovalActionPill("本次会话", palette.subtleFill, palette.textPrimary) { onDecide("allow_session") }
            Spacer(Modifier.weight(1f))
            ApprovalActionPill("拒绝", palette.rose.copy(alpha = 0.10f), palette.rose) { onDecide("deny") }
        }
    }
}

@Composable
fun ApprovalActionPill(label: String, fill: Color, fg: Color, onClick: () -> Unit) {
    Text(
        text = label,
        fontSize = 11.5.sp,
        fontFamily = ArkSansFamily,
        fontWeight = FontWeight.SemiBold,
        color = fg,
        modifier = Modifier
            .clip(CircleShape)
            .background(fill)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 5.5.dp)
    )
}

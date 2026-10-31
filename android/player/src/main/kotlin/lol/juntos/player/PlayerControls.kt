package lol.juntos.player

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.setProgress
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import lol.juntos.design.Juntos
import lol.juntos.design.JuntosIcons
import lol.juntos.design.JuntosMotion
import lol.juntos.design.easeOut
import lol.juntos.design.pop
import lol.juntos.design.settle
import kotlin.math.abs
import kotlin.math.roundToInt

/** What the controls ask for; the room decides whether it goes to the socket. */
interface PlayerIntents {
    fun play(positionMs: Long)
    fun pause(positionMs: Long)
    fun seek(positionMs: Long)
}

// web/src/player/Player.tsx: touch hides the controls 4 s after the last tap, only while playing.
private const val HIDE_AFTER_MS = 4_000L
private const val SKIP_MS = 10_000L
private const val SKIP_LONG_MS = 90_000L
private const val SKIP_LABEL_MS = 650L
private const val HOLD_SEEK_MS = 1_500L
private const val FEEDBACK_MS = 700

// The site's stage ink, rgb(3,4,7), and the warm end of the played bar.
private val INK = Color(0xFF030407)
private val WARM = Color(0xFFFF9366)
private val SPINNER = Color(0xFFFFD0B8)
private val FAINT = Color(0xFF6E6E6E)
private val PILL = Color(0xB809080A)

private class Skip(val direction: Int)
private class Feedback(val playing: Boolean)

/**
 * The site's controls over the video: a gradient under them, the bar with chapters and
 * the warm played part, play, +90 s, the time against the room's length, settings and
 * full screen. A tap brings them back, a tap on them plays or pauses, a double tap on a
 * side skips 10 s. [durationMs] is the room's length; 0 falls back to what the player knows.
 */
@Composable
fun PlayerControls(
    player: JuntosPlayer,
    intents: PlayerIntents,
    fullscreen: Boolean,
    onFullscreenChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    onSettings: (() -> Unit)? = null,
    durationMs: Long = 0,
    canControl: Boolean = true,
    chaptersMs: List<Long> = emptyList(),
    waitText: String? = null,
) {
    val snap by player.snapshot.collectAsState()
    val latest by rememberUpdatedState(snap)
    val length = if (durationMs > 0) durationMs else snap.durationMs
    val lengthNow by rememberUpdatedState(length)
    val control by rememberUpdatedState(canControl)
    var visible by remember { mutableStateOf(true) }
    var touches by remember { mutableIntStateOf(0) }
    var scrubbing by remember { mutableStateOf(false) }
    var heldMs by remember { mutableStateOf<Long?>(null) }
    var playingShown by remember { mutableStateOf(snap.playing) }
    var skip by remember { mutableStateOf<Skip?>(null) }
    var feedback by remember { mutableStateOf<Feedback?>(null) }
    var feedbacks by remember { mutableIntStateOf(0) }

    LaunchedEffect(snap.playing) { playingShown = snap.playing }
    val waiting = waitText != null || (snap.buffering && snap.playing)
    // Done loading, the controls are up at once instead of waiting for a tap.
    LaunchedEffect(waiting) {
        if (!waiting) {
            visible = true
            touches++
        }
    }
    LaunchedEffect(visible) { (player as? Media3Player)?.controlsShown?.value = visible }
    LaunchedEffect(visible, playingShown, touches, scrubbing) {
        if (visible && playingShown && !scrubbing) {
            delay(HIDE_AFTER_MS)
            visible = false
        }
    }
    LaunchedEffect(skip) {
        if (skip != null) {
            delay(SKIP_LABEL_MS)
            skip = null
        }
    }
    val held = heldMs
    // After a seek the bar stays where it was let go until the player gets there, or gives up.
    LaunchedEffect(held) {
        if (held != null) {
            withTimeoutOrNull(HOLD_SEEK_MS) { snapshotFlow { latest.positionMs }.first { abs(it - held) < 1_000 } }
            heldMs = null
        }
    }

    fun toggle() {
        touches++
        if (!control) return
        if (playingShown) intents.pause(latest.positionMs) else intents.play(latest.positionMs)
        playingShown = !playingShown
        feedback = Feedback(playingShown)
        feedbacks++
    }

    fun skipBy(ms: Long) {
        val now = latest
        val end = if (lengthNow > 0) lengthNow else Long.MAX_VALUE
        val target = (now.positionMs + ms).coerceIn(0, end)
        heldMs = target
        intents.seek(target)
    }

    val shown by animateFloatAsState(if (visible) 1f else 0f, tween(180, easing = JuntosMotion.EaseOut), label = "controls")

    Box(
        modifier
            .fillMaxSize()
            .testTag("player-gestures")
            .pointerInput(Unit) {
                detectTapGestures(
                    onTap = {
                        // A tap shows or hides the controls; playing and pausing is the button's.
                        visible = !visible
                        touches++
                    },
                    onDoubleTap = { at ->
                        val direction = when {
                            at.x < size.width / 3f -> -1
                            at.x > size.width * 2f / 3f -> 1
                            else -> 0
                        }
                        if (direction == 0 || !control) {
                            onFullscreenChange(!fullscreen)
                        } else {
                            skipBy(direction * SKIP_MS)
                            skip = Skip(direction)
                            touches++
                        }
                    },
                )
            },
    ) {
        Box(
            Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .height(if (fullscreen) 148.dp else 108.dp)
                .graphicsLayer { alpha = shown }
                .background(
                    Brush.verticalGradient(
                        0f to INK.copy(alpha = 0f),
                        0.18f to INK.copy(alpha = 0.08f),
                        0.38f to INK.copy(alpha = 0.26f),
                        0.6f to INK.copy(alpha = 0.5f),
                        0.82f to INK.copy(alpha = 0.72f),
                        1f to INK.copy(alpha = 0.86f),
                    ),
                ),
        )

        SkipLabel(skip, Alignment.CenterStart, -1)
        SkipLabel(skip, Alignment.CenterEnd, 1)
        feedback?.let { key(feedbacks) { CenterFeedback(it.playing, Modifier.align(Alignment.Center)) } }

        if (waiting) {
            Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Spinner()
                if (waitText != null) {
                    Text(
                        waitText,
                        color = Color(0xFF9B9B9B),
                        fontSize = 13.sp,
                        modifier = Modifier
                            .clip(RoundedCornerShape(14.dp))
                            .background(PILL)
                            .padding(horizontal = 16.dp, vertical = 10.dp),
                    )
                }
            }
        }

        AnimatedVisibility(
            visible = visible,
            enter = fadeIn(tween(180, easing = JuntosMotion.EaseOut)) + slideInVertically(tween(180, easing = JuntosMotion.EaseOut)) { it / 8 },
            exit = fadeOut(tween(180, easing = JuntosMotion.EaseOut)) + slideOutVertically(tween(180, easing = JuntosMotion.EaseOut)) { it / 8 },
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .padding(horizontal = 8.dp)
                .padding(bottom = if (fullscreen) 8.dp else 4.dp),
        ) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .testTag("player-controls")
                    .padding(horizontal = 8.dp, vertical = 4.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                SeekBar(
                    positionMs = held ?: snap.positionMs,
                    durationMs = length,
                    bufferedMs = snap.positionMs + snap.bufferedAheadMs,
                    chaptersMs = chaptersMs,
                    enabled = canControl,
                    onScrubbing = {
                        scrubbing = it
                        touches++
                    },
                    onSeek = {
                        heldMs = it
                        intents.seek(it)
                    },
                )
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    PlayPauseButton(playing = playingShown, enabled = canControl, onClick = ::toggle)
                    if (canControl) {
                        SkipLongButton(onClick = {
                            touches++
                            skipBy(SKIP_LONG_MS)
                        })
                    }
                    Clock(held ?: snap.positionMs, length)
                    Spacer(Modifier.weight(1f))
                    if (onSettings != null) {
                        ControlButton(label = "Configurações", onClick = {
                            touches++
                            onSettings()
                        }) { Glyph(Icons.Outlined.Settings, 20.dp) }
                    }
                    ControlButton(
                        label = if (fullscreen) "Sair da tela cheia" else "Tela cheia",
                        onClick = {
                            touches++
                            onFullscreenChange(!fullscreen)
                        },
                    ) { Glyph(if (fullscreen) JuntosIcons.Minimize else JuntosIcons.Maximize, 18.dp) }
                }
            }
        }
    }
}

@Composable
private fun Glyph(icon: ImageVector, size: Dp) {
    Icon(icon, contentDescription = null, tint = Color.White, modifier = Modifier.size(size))
}

/** "12:04 / 24:10", the slash in faint ink; minutes run past sixty. */
@Composable
private fun Clock(positionMs: Long, durationMs: Long) {
    val style = TextStyle(color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Medium, fontFeatureSettings = "tnum")
    Row(Modifier.padding(start = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(timecode(positionMs), style = style)
        Text("/", style = style.copy(color = FAINT), modifier = Modifier.padding(horizontal = 5.dp))
        Text(if (durationMs > 0) timecode(durationMs) else "--:--", style = style)
    }
}

@Composable
private fun SkipLongButton(onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) 0.92f else 1f, easeOut(JuntosMotion.PRESS_MS), label = "skip90")
    Row(
        Modifier
            .scale(scale)
            .height(40.dp)
            .clip(CircleShape)
            .clickable(interaction, indication = null, role = Role.Button, onClick = onClick)
            .semantics(mergeDescendants = true) { contentDescription = "Avançar 90 segundos" }
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(JuntosIcons.RotateCw, contentDescription = null, tint = Color.White, modifier = Modifier.size(14.dp))
        Text("90", color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
    }
}

/** 42 dp, a faint ring with a warm arc going round every 0.8 s. */
@Composable
private fun Spinner() {
    val turn by rememberInfiniteTransition(label = "spinner").animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(tween(800, easing = LinearEasing), RepeatMode.Restart),
        label = "spin",
    )
    Canvas(Modifier.size(42.dp).semantics { contentDescription = "Carregando" }) {
        val stroke = 3.dp.toPx()
        val inset = stroke / 2
        val box = androidx.compose.ui.geometry.Size(size.width - stroke, size.height - stroke)
        drawArc(Color.White.copy(alpha = 0.16f), 0f, 360f, false, Offset(inset, inset), box, style = Stroke(stroke))
        drawArc(SPINNER, turn - 90f, 90f, false, Offset(inset, inset), box, style = Stroke(stroke, cap = StrokeCap.Butt))
    }
}

/** The pop in the middle when a tap plays or pauses: grows in, holds, fades out a little larger. */
@Composable
private fun CenterFeedback(playing: Boolean, modifier: Modifier) {
    val t = remember { Animatable(0f) }
    LaunchedEffect(Unit) { t.animateTo(1f, tween(FEEDBACK_MS, easing = LinearEasing)) }
    val p = t.value
    val scale = when {
        p < 0.18f -> 0.86f + 0.14f * (p / 0.18f)
        p < 0.7f -> 1f
        else -> 1f + 0.04f * ((p - 0.7f) / 0.3f)
    }
    val alpha = when {
        p < 0.18f -> p / 0.18f
        p < 0.7f -> 1f
        else -> 1f - (p - 0.7f) / 0.3f
    }
    if (p >= 1f) return
    Box(
        modifier
            .graphicsLayer { scaleX = scale; scaleY = scale; this.alpha = alpha }
            .defaultMinSize(minWidth = 92.dp)
            .clip(RoundedCornerShape(20.dp))
            .background(PILL)
            .padding(horizontal = 20.dp, vertical = 16.dp),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.size(22.dp)) { drawPlayPause(if (playing) 0f else 1f) }
    }
}

@Composable
private fun SkipLabel(skip: Skip?, alignment: Alignment, direction: Int) {
    val shown = skip?.direction == direction
    Box(Modifier.fillMaxSize(), contentAlignment = alignment) {
        AnimatedVisibility(
            visible = shown,
            enter = fadeIn(pop()) + scaleIn(pop(), initialScale = 0.6f),
            exit = fadeOut(settle()),
            modifier = Modifier.padding(horizontal = 40.dp),
        ) {
            Text(
                text = if (direction < 0) "−10 s" else "+10 s",
                color = Color.White,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier
                    .clip(RoundedCornerShape(20.dp))
                    .background(PILL)
                    .padding(horizontal = 16.dp, vertical = 10.dp),
            )
        }
    }
}

@Composable
private fun ControlButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, content: @Composable () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) 0.9f else 1f, easeOut(JuntosMotion.PRESS_MS), label = "press")
    Box(
        contentAlignment = Alignment.Center,
        modifier = modifier
            .size(40.dp)
            .scale(scale)
            .clip(CircleShape)
            .clickable(interactionSource = interaction, indication = null, role = Role.Button, enabled = enabled, onClick = onClick)
            .semantics { contentDescription = label },
    ) { content() }
}

@Composable
private fun PlayPauseButton(playing: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val morph by animateFloatAsState(if (playing) 1f else 0f, pop(), label = "play-pause")
    ControlButton(label = if (playing) "Pausar" else "Reproduzir", onClick = onClick, enabled = enabled) {
        Canvas(Modifier.size(17.dp).graphicsLayer { alpha = if (enabled) 1f else 0.5f }) { drawPlayPause(morph) }
    }
}

// Play is a triangle cut in two at its middle; pause is two bars. Each half's corners travel.
private val PLAY = arrayOf(
    floatArrayOf(0.2f, 0.06f, 0.56f, 0.28f, 0.56f, 0.72f, 0.2f, 0.94f),
    floatArrayOf(0.56f, 0.28f, 0.92f, 0.5f, 0.92f, 0.5f, 0.56f, 0.72f),
)
private val PAUSE = arrayOf(
    floatArrayOf(0.16f, 0.08f, 0.4f, 0.08f, 0.4f, 0.92f, 0.16f, 0.92f),
    floatArrayOf(0.6f, 0.08f, 0.84f, 0.08f, 0.84f, 0.92f, 0.6f, 0.92f),
)

private fun DrawScope.drawPlayPause(t: Float) {
    for (half in 0..1) {
        val from = PLAY[half]
        val to = PAUSE[half]
        val path = Path()
        for (corner in 0..3) {
            val x = (from[corner * 2] + (to[corner * 2] - from[corner * 2]) * t) * size.width
            val y = (from[corner * 2 + 1] + (to[corner * 2 + 1] - from[corner * 2 + 1]) * t) * size.height
            if (corner == 0) path.moveTo(x, y) else path.lineTo(x, y)
        }
        path.close()
        drawPath(path, Color.White)
    }
}

@Composable
private fun SeekBar(
    positionMs: Long,
    durationMs: Long,
    bufferedMs: Long,
    chaptersMs: List<Long>,
    enabled: Boolean,
    onScrubbing: (Boolean) -> Unit,
    onSeek: (Long) -> Unit,
) {
    var scrubMs by remember { mutableStateOf<Long?>(null) }
    val duration by rememberUpdatedState(durationMs)
    val canSeek by rememberUpdatedState(enabled)
    val shownMs = scrubMs ?: positionMs
    val fraction = if (durationMs > 0) (shownMs.toFloat() / durationMs).coerceIn(0f, 1f) else 0f
    val buffered = if (durationMs > 0) (bufferedMs.toFloat() / durationMs).coerceIn(fraction, 1f) else 0f
    val thumb by animateDpAsState(if (scrubMs != null) 15.dp else 13.dp, tween(160, easing = JuntosMotion.EaseOut), label = "thumb")
    val track by animateDpAsState(if (scrubMs != null) 10.dp else 6.dp, tween(160, easing = JuntosMotion.EaseOut), label = "track")
    val primary = Juntos.colors.primary
    val density = LocalDensity.current

    BoxWithConstraints(
        Modifier
            .fillMaxWidth()
            .height(44.dp)
            .testTag("player-seekbar")
            .semantics {
                contentDescription = "Posição"
                progressBarRangeInfo = ProgressBarRangeInfo(fraction, 0f..1f)
                if (enabled) {
                    setProgress { target ->
                        if (duration <= 0) return@setProgress false
                        onSeek((target.coerceIn(0f, 1f) * duration).toLong())
                        true
                    }
                }
            }
            .pointerInput(Unit) {
                fun at(x: Float) = (x / size.width).coerceIn(0f, 1f).let { (it * duration).toLong() }
                awaitEachGesture {
                    val down = awaitFirstDown()
                    if (duration <= 0 || !canSeek) return@awaitEachGesture
                    down.consume()
                    scrubMs = at(down.position.x)
                    onScrubbing(true)
                    while (true) {
                        val change = awaitPointerEvent().changes.firstOrNull { it.id == down.id } ?: break
                        if (!change.pressed) break
                        scrubMs = at(change.position.x)
                        change.consume()
                    }
                    scrubMs?.let(onSeek)
                    scrubMs = null
                    onScrubbing(false)
                }
            },
        contentAlignment = Alignment.CenterStart,
    ) {
        val width = maxWidth
        Canvas(Modifier.fillMaxWidth().height(track)) {
            val h = size.height
            val radius = androidx.compose.ui.geometry.CornerRadius(h / 2, h / 2)
            drawRoundRect(Color.White.copy(alpha = 0.24f), cornerRadius = radius)
            if (buffered > fraction) {
                drawRoundRect(
                    Color.White.copy(alpha = 0.38f),
                    topLeft = Offset(size.width * fraction, 0f),
                    size = androidx.compose.ui.geometry.Size(size.width * (buffered - fraction), h),
                    cornerRadius = radius,
                )
            }
            if (fraction > 0f) {
                drawRoundRect(
                    Brush.horizontalGradient(listOf(primary, WARM), startX = 0f, endX = size.width),
                    size = androidx.compose.ui.geometry.Size(size.width * fraction, h),
                    cornerRadius = radius,
                )
            }
            if (duration > 0) {
                chaptersMs.filter { it in 1 until duration }.forEach { start ->
                    val x = size.width * start / duration
                    drawRect(INK.copy(alpha = 0.9f), topLeft = Offset(x - 1.5.dp.toPx(), 0f), size = androidx.compose.ui.geometry.Size(3.dp.toPx(), h))
                }
            }
        }
        if (enabled) {
            Box(
                Modifier
                    .offset { IntOffset((with(density) { (width * fraction - thumb / 2).toPx() }).roundToInt(), 0) }
                    .size(thumb)
                    .shadow(4.dp, CircleShape)
                    .clip(CircleShape)
                    .background(Color.White),
            )
        }
        val scrub = scrubMs
        if (scrub != null) ScrubPreview(scrub, fraction, width)
    }
}

/** The time under the finger, as the site's hover bubble: 10 dp over the bar, kept inside it. */
@Composable
private fun ScrubPreview(ms: Long, fraction: Float, width: Dp) {
    val bubble = 58.dp
    val x = (width * fraction - bubble / 2).coerceIn(0.dp, (width - bubble).coerceAtLeast(0.dp))
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .testTag("player-scrub-preview")
            .offset(x = x, y = (-34).dp)
            .width(bubble)
            .clip(RoundedCornerShape(9.dp))
            .background(Color(0xF00A0B10))
            .padding(horizontal = 10.dp, vertical = 5.dp),
    ) {
        Text(timecode(ms), color = Color.White, fontSize = 11.5.sp, fontWeight = FontWeight.Medium, textAlign = TextAlign.Center)
    }
}

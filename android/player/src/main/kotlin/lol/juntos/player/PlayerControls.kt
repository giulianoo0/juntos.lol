package lol.juntos.player

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
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
import androidx.compose.material.icons.rounded.Fullscreen
import androidx.compose.material.icons.rounded.FullscreenExit
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.setProgress
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import lol.juntos.design.Juntos
import lol.juntos.design.JuntosMotion
import lol.juntos.design.JuntosSpacing
import lol.juntos.design.JuntosTextSize
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

private const val HIDE_AFTER_MS = 3_000L
private const val SKIP_MS = 10_000L
private const val SKIP_LABEL_MS = 650L
private const val HOLD_SEEK_MS = 1_500L

private class Skip(val direction: Int)

/**
 * The phone's controls over the video: a tap shows and hides them, a double tap on
 * either side skips 10 s, the bar scrubs with a time preview.
 */
@Composable
fun PlayerControls(
    player: JuntosPlayer,
    intents: PlayerIntents,
    fullscreen: Boolean,
    onFullscreenChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val snap by player.snapshot.collectAsState()
    val latest by rememberUpdatedState(snap)
    var visible by remember { mutableStateOf(true) }
    var touches by remember { mutableIntStateOf(0) }
    var scrubbing by remember { mutableStateOf(false) }
    var heldMs by remember { mutableStateOf<Long?>(null) }
    var playingShown by remember { mutableStateOf(snap.playing) }
    var skip by remember { mutableStateOf<Skip?>(null) }

    LaunchedEffect(snap.playing) { playingShown = snap.playing }
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

    Box(
        modifier
            .fillMaxSize()
            .testTag("player-gestures")
            .pointerInput(Unit) {
                detectTapGestures(
                    onTap = {
                        visible = !visible
                        touches++
                    },
                    onDoubleTap = { at ->
                        val direction = when {
                            at.x < size.width * 0.4f -> -1
                            at.x > size.width * 0.6f -> 1
                            else -> 0
                        }
                        if (direction == 0) {
                            visible = !visible
                        } else {
                            val now = latest
                            val end = if (now.durationMs > 0) now.durationMs else Long.MAX_VALUE
                            intents.seek((now.positionMs + direction * SKIP_MS).coerceIn(0, end))
                            skip = Skip(direction)
                            touches++
                        }
                    },
                )
            },
    ) {
        SkipLabel(skip, Alignment.CenterStart, -1)
        SkipLabel(skip, Alignment.CenterEnd, 1)

        if (snap.buffering && snap.playing && !visible) {
            CircularProgressIndicator(
                color = Color.White,
                strokeWidth = 2.dp,
                modifier = Modifier.align(Alignment.Center).size(32.dp),
            )
        }

        AnimatedVisibility(
            visible = visible,
            enter = fadeIn(settle()),
            exit = fadeOut(settle()),
            modifier = Modifier.fillMaxSize(),
        ) {
            Box(Modifier.fillMaxSize().testTag("player-controls")) {
                Box(
                    Modifier
                        .fillMaxSize()
                        .background(Brush.verticalGradient(0f to Color.Black.copy(alpha = 0.25f), 0.35f to Color.Transparent, 0.6f to Color.Transparent, 1f to Color.Black.copy(alpha = 0.6f))),
                )
                PlayPauseButton(
                    playing = playingShown,
                    onClick = {
                        touches++
                        if (playingShown) intents.pause(latest.positionMs) else intents.play(latest.positionMs)
                        playingShown = !playingShown
                    },
                    modifier = Modifier.align(Alignment.Center),
                )
                Column(
                    Modifier
                        .align(Alignment.BottomCenter)
                        .fillMaxWidth()
                        .padding(horizontal = JuntosSpacing.s4),
                ) {
                    SeekBar(
                        positionMs = held ?: snap.positionMs,
                        durationMs = snap.durationMs,
                        bufferedMs = snap.positionMs + snap.bufferedAheadMs,
                        onScrubbing = {
                            scrubbing = it
                            touches++
                        },
                        onSeek = {
                            heldMs = it
                            intents.seek(it)
                        },
                    )
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            text = "${timecode(held ?: snap.positionMs)} / ${timecode(snap.durationMs)}",
                            color = Color.White,
                            fontSize = JuntosTextSize.xs,
                            fontWeight = FontWeight.Medium,
                            modifier = Modifier.padding(start = JuntosSpacing.s1),
                        )
                        Spacer(Modifier.weight(1f))
                        ControlButton(
                            label = if (fullscreen) "Sair da tela cheia" else "Tela cheia",
                            onClick = {
                                touches++
                                onFullscreenChange(!fullscreen)
                            },
                        ) {
                            Icon(
                                if (fullscreen) Icons.Rounded.FullscreenExit else Icons.Rounded.Fullscreen,
                                contentDescription = null,
                                tint = Color.White,
                                modifier = Modifier.size(24.dp),
                            )
                        }
                    }
                }
            }
        }
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
            modifier = Modifier.padding(horizontal = JuntosSpacing.s10),
        ) {
            Text(
                text = if (direction < 0) "−10 s" else "+10 s",
                color = Color.White,
                fontSize = JuntosTextSize.sm,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier
                    .clip(RoundedCornerShape(999.dp))
                    .background(Color.Black.copy(alpha = 0.45f))
                    .padding(horizontal = JuntosSpacing.s4, vertical = JuntosSpacing.s2),
            )
        }
    }
}

@Composable
private fun ControlButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) 0.9f else 1f, easeOut(JuntosMotion.PRESS_MS))
    Box(
        contentAlignment = Alignment.Center,
        modifier = modifier
            .size(JuntosSpacing.touchTarget)
            .scale(scale)
            .clickable(interactionSource = interaction, indication = null, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = label },
    ) { content() }
}

@Composable
private fun PlayPauseButton(playing: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val morph by animateFloatAsState(if (playing) 1f else 0f, pop())
    ControlButton(
        label = if (playing) "Pausar" else "Reproduzir",
        onClick = onClick,
        modifier = modifier
            .size(64.dp)
            .clip(CircleShape)
            .background(Color.Black.copy(alpha = 0.35f)),
    ) {
        Canvas(Modifier.size(26.dp)) { drawPlayPause(morph) }
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
    onScrubbing: (Boolean) -> Unit,
    onSeek: (Long) -> Unit,
) {
    var scrubMs by remember { mutableStateOf<Long?>(null) }
    val duration by rememberUpdatedState(durationMs)
    val shownMs = scrubMs ?: positionMs
    val fraction = if (durationMs > 0) (shownMs.toFloat() / durationMs).coerceIn(0f, 1f) else 0f
    val buffered = if (durationMs > 0) (bufferedMs.toFloat() / durationMs).coerceIn(0f, 1f) else 0f
    val thumb by animateDpAsState(if (scrubMs != null) 16.dp else 12.dp, pop())
    val track by animateDpAsState(if (scrubMs != null) 6.dp else 4.dp, pop())
    val primary = Juntos.colors.primary
    val density = LocalDensity.current

    BoxWithConstraints(
        Modifier
            .fillMaxWidth()
            .height(JuntosSpacing.touchTarget)
            .testTag("player-seekbar")
            .semantics {
                contentDescription = "Posição"
                progressBarRangeInfo = ProgressBarRangeInfo(fraction, 0f..1f)
                setProgress { target ->
                    if (duration <= 0) return@setProgress false
                    onSeek((target.coerceIn(0f, 1f) * duration).toLong())
                    true
                }
            }
            .pointerInput(Unit) {
                fun at(x: Float) = (x / size.width).coerceIn(0f, 1f).let { (it * duration).toLong() }
                awaitEachGesture {
                    val down = awaitFirstDown()
                    if (duration <= 0) return@awaitEachGesture
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
        Box(Modifier.fillMaxWidth().height(track).clip(CircleShape).background(Color.White.copy(alpha = 0.25f))) {
            Box(Modifier.fillMaxHeight().width(width * buffered).background(Color.White.copy(alpha = 0.35f)))
            Box(Modifier.fillMaxHeight().width(width * fraction).background(primary))
        }
        Box(
            Modifier
                .offset { IntOffset((with(density) { (width * fraction - thumb / 2).toPx() }).roundToInt(), 0) }
                .size(thumb)
                .clip(CircleShape)
                .background(Color.White),
        )
        val scrub = scrubMs
        if (scrub != null) {
            ScrubPreview(scrub, fraction, width)
        }
    }
}

@Composable
private fun ScrubPreview(ms: Long, fraction: Float, width: Dp) {
    val bubble = 56.dp
    val x = (width * fraction - bubble / 2).coerceIn(0.dp, (width - bubble).coerceAtLeast(0.dp))
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .testTag("player-scrub-preview")
            .offset(x = x, y = (-36).dp)
            .width(bubble)
            .clip(RoundedCornerShape(999.dp))
            .background(Color.Black.copy(alpha = 0.7f))
            .padding(vertical = JuntosSpacing.s1),
    ) {
        Text(timecode(ms), color = Color.White, fontSize = JuntosTextSize.xs, fontWeight = FontWeight.SemiBold)
    }
}

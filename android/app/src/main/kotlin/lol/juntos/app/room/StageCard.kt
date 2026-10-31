package lol.juntos.app.room

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import lol.juntos.core.model.RoomPreparation
import lol.juntos.core.model.SwarmStats
import lol.juntos.design.Juntos
import lol.juntos.design.pop
import kotlin.math.roundToInt

private val WARM = Color(0xFFFF9366)

/**
 * The site's "Preparando seu vídeo" over a stage that has nothing to play yet: the phase the
 * server reports and the preview's share, or a streak drifting across while nothing says.
 */
@Composable
fun PreparingCard(prep: RoomPreparation?, swarm: SwarmStats?, durationMs: Long, failed: String?, modifier: Modifier = Modifier) {
    val progress = preparationProgress(prep, durationMs)
    val received = prep?.receivedBytes ?: 0
    val target = prepTarget(prep, durationMs)
    val rate = rememberRate(received)
    val eta = etaLabel(etaSeconds(received, target.bytes, rate), arrived = target.bytes > 0 && received >= target.bytes)
    val started = target.bytes > 0
    val shown by animateFloatAsState(progress ?: 0f, pop(), label = "prep")
    BoxWithConstraints(modifier.fillMaxSize().background(Color(0xFF030407)), contentAlignment = Alignment.Center) {
        // A portrait 16:9 stage is short: the card loses its frame and keeps to one line per row.
        val compact = maxHeight < 260.dp
        val tight = maxHeight < 190.dp
        val shape = RoundedCornerShape(22.dp)
        Column(
            Modifier
                .widthIn(max = 480.dp)
                .fillMaxWidth()
                .padding(if (compact) 12.dp else 16.dp)
                .then(if (compact) Modifier else Modifier.clip(shape).border(1.dp, Color.White.copy(alpha = 0.1f), shape).padding(horizontal = 20.dp, vertical = 18.dp)),
            verticalArrangement = Arrangement.spacedBy(if (compact) 8.dp else 10.dp),
        ) {
            Text(
                if (failed != null) "Falha ao processar o vídeo" else "Preparando seu vídeo",
                color = Color(0xFFEDEDED),
                fontSize = if (compact) 16.sp else 19.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            val line = failed ?: preparationLine(prep)
            if (line != null && !(tight && swarm != null)) Text(line, color = Color(0xFF9B9B9B), fontSize = if (compact) 12.sp else 13.sp, maxLines = if (compact) 2 else 3, overflow = TextOverflow.Ellipsis)
            if (failed == null) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    PrepBar(if (progress == null) null else shown, Modifier.weight(1f))
                    if (progress != null) Text("${(progress * 100).roundToInt()}%", color = Color(0xFF9B9B9B), fontSize = 12.sp)
                }
                if (started) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(if (target.untilPlayable) "Começa a reproduzir em" else "Termina em", color = Color(0xFF9B9B9B), fontSize = 12.sp, modifier = Modifier.weight(1f))
                        Text(eta ?: "calculando", color = if (eta != null) Color(0xFFEDEDED) else Color(0xFF6E6E6E), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
                if (swarm != null) SwarmRow(swarm)
            }
        }
    }
}

@Composable
private fun SwarmRow(swarm: SwarmStats) {
    Row(Modifier.fillMaxWidth()) {
        Stat("Peers", "${swarm.peers}", Modifier.weight(1f))
        Stat("Velocidade", megabytesPerSecond(swarm.downSpeed), Modifier.weight(1f))
        Stat("Baixado", byteSize(swarm.haveBytes), Modifier.weight(1f))
    }
}

@Composable
private fun Stat(label: String, value: String, modifier: Modifier) {
    Column(modifier) {
        Text(label, color = Color(0xFF9B9B9B), fontSize = 11.sp, maxLines = 1)
        Text(value, color = Color(0xFFEDEDED), fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
    }
}

private const val RATE_WINDOW_MS = 20_000L

/** Bytes per second over the last 20 s of [receivedBytes], as the site measures it. */
@Composable
private fun rememberRate(receivedBytes: Long): Double {
    val samples = remember { ArrayDeque<Pair<Long, Long>>() }
    var rate by remember { mutableDoubleStateOf(0.0) }
    LaunchedEffect(receivedBytes) {
        val now = System.currentTimeMillis()
        if (samples.isNotEmpty() && receivedBytes < samples.last().second) samples.clear()
        samples.addLast(now to receivedBytes)
        while (samples.size > 2 && now - samples.first().first > RATE_WINDOW_MS) samples.removeFirst()
        val (at, bytes) = samples.first()
        val elapsed = (now - at) / 1000.0
        rate = if (elapsed >= 1) (receivedBytes - bytes) / elapsed else 0.0
    }
    return rate
}

@Composable
private fun PrepBar(fraction: Float?, modifier: Modifier) {
    val primary = Juntos.colors.primary
    val drift by rememberInfiniteTransition(label = "prep-bar").animateFloat(
        initialValue = -0.38f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(1_700, easing = LinearEasing), RepeatMode.Restart),
        label = "streak",
    )
    Canvas(modifier.height(8.dp)) {
        val r = CornerRadius(size.height / 2, size.height / 2)
        drawRoundRect(Color.White.copy(alpha = 0.1f), cornerRadius = r)
        if (fraction == null) {
            val w = size.width * 0.38f
            drawRoundRect(Color(0x998E94FF), topLeft = Offset(size.width * drift, 0f), size = Size(w, size.height), cornerRadius = r)
        } else if (fraction > 0f) {
            drawRoundRect(
                Brush.horizontalGradient(listOf(primary, WARM), endX = size.width),
                size = Size(size.width * fraction, size.height),
                cornerRadius = r,
            )
        }
    }
}

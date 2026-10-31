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
import androidx.compose.runtime.getValue
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
import lol.juntos.design.Juntos
import lol.juntos.design.pop
import kotlin.math.roundToInt

private val WARM = Color(0xFFFF9366)

/**
 * The site's "Preparando seu vídeo" over a stage that has nothing to play yet: the phase the
 * server reports and the preview's share, or a streak drifting across while nothing says.
 */
@Composable
fun PreparingCard(prep: RoomPreparation?, failed: String?, modifier: Modifier = Modifier) {
    val progress = preparationProgress(prep)
    val shown by animateFloatAsState(progress ?: 0f, pop(), label = "prep")
    BoxWithConstraints(modifier.fillMaxSize().background(Color(0xFF030407)), contentAlignment = Alignment.Center) {
        // A portrait 16:9 stage is short: the card loses its frame and keeps to one line per row.
        val compact = maxHeight < 260.dp
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
            if (line != null) Text(line, color = Color(0xFF9B9B9B), fontSize = if (compact) 12.sp else 13.sp, maxLines = if (compact) 2 else 3, overflow = TextOverflow.Ellipsis)
            if (failed == null) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    PrepBar(if (progress == null) null else shown, Modifier.weight(1f))
                    if (progress != null) Text("${(progress * 100).roundToInt()}%", color = Color(0xFF9B9B9B), fontSize = 12.sp)
                }
            }
        }
    }
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

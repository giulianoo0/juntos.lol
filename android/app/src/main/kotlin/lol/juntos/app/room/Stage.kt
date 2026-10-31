package lol.juntos.app.room

import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import lol.juntos.core.model.Member
import lol.juntos.core.sync.Connection
import lol.juntos.core.sync.SyncState
import lol.juntos.design.Avatar
import lol.juntos.design.IconPill
import lol.juntos.design.Juntos
import lol.juntos.design.JuntosIcons
import lol.juntos.design.JuntosMotion
import lol.juntos.design.JuntosRadii
import lol.juntos.design.JuntosTextSize
import lol.juntos.design.LocalMotionEnabled
import lol.juntos.design.PillTone
import lol.juntos.design.pop
import lol.juntos.design.pressScale
import kotlin.random.Random

@Composable
fun RoomHeader(state: SyncState, roomId: String, onPeople: () -> Unit, onCopied: () -> Unit, modifier: Modifier = Modifier) {
    val c = Juntos.colors
    val live = state.connection == Connection.Open
    Row(
        modifier.fillMaxWidth().height(60.dp).padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            Modifier
                .size(8.dp)
                .background(if (live) c.success else c.textFaint, CircleShape)
                .semantics { contentDescription = if (live) "Conectado" else "Conectando" },
        )
        Text(
            state.room?.name?.takeIf { it.isNotBlank() } ?: "Sala",
            color = c.text,
            fontSize = JuntosTextSize.lg,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            modifier = Modifier.weight(1f),
        )
        Invite(roomId, onCopied)
        PeoplePill(state.members, onClick = onPeople)
    }
}

@Composable
private fun PeoplePill(members: List<Member>, onClick: () -> Unit) {
    val c = Juntos.colors
    val interaction = remember { androidx.compose.foundation.interaction.MutableInteractionSource() }
    Row(
        Modifier
            .pressScale(interaction)
            .height(36.dp)
            .clip(CircleShape)
            .background(c.buttonSecondary)
            .clickable(interaction, indication = null, onClick = onClick)
            .semantics(mergeDescendants = true) { contentDescription = "Pessoas na sala" }
            .padding(start = 4.dp, end = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        members.take(3).forEachIndexed { i, m ->
            Avatar(m.id, m.nickname, m.avatar, 28.dp, Modifier.offset(x = (-8 * i).dp).animateContentSize())
        }
        Spacer(Modifier.width((8 - 8 * (members.take(3).size - 1)).coerceAtMost(8).dp))
        Text("${members.size}", color = c.text, fontSize = JuntosTextSize.sm, fontWeight = FontWeight.SemiBold)
    }
}

/** Reactions float up over the stage and fade, here on this phone. */
@Stable
class Bursts {
    internal val live = mutableStateListOf<Pair<Long, String>>()
    private var next = 0L
    fun add(emoji: String) { live += (next++ to emoji) }
}

@Composable
fun BurstLayer(bursts: Bursts, modifier: Modifier = Modifier) {
    BoxWithConstraints(modifier) {
        val h = maxHeight
        val w = maxWidth
        bursts.live.forEach { (id, emoji) ->
            key(id) {
                val p = remember { Animatable(0f) }
                val x = remember { Random.nextFloat() * 0.6f + 0.2f }
                LaunchedEffect(Unit) {
                    p.animateTo(1f, tween(1_800, easing = LinearEasing))
                    bursts.live.removeAll { it.first == id }
                }
                Text(
                    emoji,
                    fontSize = 34.sp,
                    modifier = Modifier
                        .offset(x = w * x, y = h - 48.dp)
                        .graphicsLayer {
                            translationY = -p.value * h.toPx() * 0.7f
                            val s = if (p.value < 0.15f) p.value / 0.15f else 1f
                            scaleX = s; scaleY = s
                            alpha = 1f - ((p.value - 0.6f) / 0.4f).coerceIn(0f, 1f)
                        },
                )
            }
        }
    }
}

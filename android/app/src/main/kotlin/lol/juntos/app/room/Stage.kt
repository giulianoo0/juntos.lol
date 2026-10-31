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
fun RoomHeader(state: SyncState, onPeople: () -> Unit, onSettings: () -> Unit, modifier: Modifier = Modifier) {
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
            state.room?.name ?: "Sala",
            color = c.text,
            fontSize = JuntosTextSize.lg,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            modifier = Modifier.weight(1f),
        )
        PeoplePill(state.members, onClick = onPeople)
        IconPill(label = "Configurações", icon = JuntosIcons.Settings, onClick = onSettings, size = 36.dp)
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

/**
 * The people under the stage. Someone arriving pops in, someone leaving folds away, and
 * a pin or a camera reorders the grid: every move rides the spring, the way Meet does it.
 */
@Composable
fun PeopleGrid(members: List<Member>, controllerId: String?, pinned: String?, onPin: (String) -> Unit, modifier: Modifier = Modifier) {
    val tiles = tilesFor(members, pinned)
    val place = pop<IntOffset>()
    val fadeIn = pop<Float>()
    val motion = LocalMotionEnabled.current
    LazyVerticalGrid(
        columns = GridCells.Fixed(2),
        modifier = modifier,
        contentPadding = PaddingValues(8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(tiles, key = { it.member.id }, span = { GridItemSpan(it.span) }) { slot ->
            PersonTile(
                member = slot.member,
                wide = slot.span == 2,
                host = slot.member.id == controllerId,
                pinned = slot.member.id == pinned,
                onPin = { onPin(slot.member.id) },
                modifier = Modifier.animateItem(
                    fadeInSpec = if (motion) fadeIn else null,
                    placementSpec = place,
                    fadeOutSpec = if (motion) tween(JuntosMotion.SETTLE_MS, easing = JuntosMotion.SpringSettle) else null,
                ),
            )
        }
    }
}

@Composable
private fun PersonTile(member: Member, wide: Boolean, host: Boolean, pinned: Boolean, onPin: () -> Unit, modifier: Modifier) {
    val c = Juntos.colors
    val motion = LocalMotionEnabled.current
    val arrive = remember { Animatable(if (motion) 0f else 1f) }
    LaunchedEffect(Unit) { arrive.animateTo(1f, tween(JuntosMotion.POP_MS, easing = JuntosMotion.SpringPop)) }
    BoxWithConstraints(
        modifier
            .animateContentSize(pop())
            .fillMaxWidth()
            .aspectRatio(if (wide) 16f / 9f else 1f)
            .clip(RoundedCornerShape(JuntosRadii.xl3))
            .background(if (member.cam == true) c.tile2 else c.tile),
    ) {
        Avatar(
            member.id,
            member.nickname,
            member.avatar,
            size = minOf(maxWidth, maxHeight) * 0.5f,
            modifier = Modifier.align(Alignment.Center).graphicsLayer { scaleX = arrive.value; scaleY = arrive.value },
        )
        IconPill(
            label = if (pinned) "Desafixar" else "Fixar",
            icon = JuntosIcons.Pin,
            onClick = onPin,
            tone = PillTone.Glass,
            active = pinned,
            size = 36.dp,
            modifier = Modifier.align(Alignment.TopEnd).padding(8.dp),
        )
        Row(
            Modifier
                .align(Alignment.BottomStart)
                .padding(8.dp)
                .clip(CircleShape)
                .background(c.scrim)
                .padding(horizontal = 10.dp, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            if (member.mic != true) Icon(JuntosIcons.MicOff, "Microfone desligado", tint = c.onScrim, modifier = Modifier.size(13.dp))
            if (member.cam == true) Icon(JuntosIcons.Cam, "Câmera ligada", tint = c.onScrim, modifier = Modifier.size(13.dp))
            if (host) Text("👑", fontSize = 11.sp)
            Text(member.nickname, color = c.onScrim, fontSize = JuntosTextSize.xs, fontWeight = FontWeight.Medium, maxLines = 1)
        }
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

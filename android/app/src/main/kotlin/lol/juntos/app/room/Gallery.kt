package lol.juntos.app.room

import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.animateBounds
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.LookaheadScope
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import lol.juntos.core.model.Member
import lol.juntos.design.Avatar
import lol.juntos.design.BoundsSpring
import lol.juntos.design.IconPill
import lol.juntos.design.Juntos
import lol.juntos.design.JuntosIcons
import lol.juntos.design.JuntosMotion
import lol.juntos.design.JuntosRadii
import lol.juntos.design.JuntosTextSize
import lol.juntos.design.LocalMotionEnabled
import lol.juntos.design.PillTone
import lol.juntos.design.pop

private val GAP = 8.dp

/**
 * The people in pages, the way Zoom shows them: every tile whole, as many per page as
 * the screen holds, a swipe to the next. Someone arriving or a camera going on moves
 * the tiles on the spring.
 */
@OptIn(ExperimentalSharedTransitionApi::class)
@Composable
fun Gallery(members: List<Member>, controllerId: String?, pinned: String?, onPin: (String) -> Unit, modifier: Modifier = Modifier) {
    val perPage = tilesPerPage(LocalConfiguration.current.smallestScreenWidthDp)
    val pages = galleryOrder(members, pinned).chunked(perPage)
    val pager = rememberPagerState { pages.size }
    LaunchedEffect(pinned) { if (pinned != null) pager.animateScrollToPage(0) }
    Column(modifier) {
        HorizontalPager(
            state = pager,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(horizontal = GAP),
            pageSpacing = GAP,
            key = { it },
        ) { index ->
            val page = pages.getOrNull(index).orEmpty()
            BoxWithConstraints(Modifier.fillMaxSize().padding(vertical = GAP)) {
                val grid = gridFor(page.size, maxWidth.value, maxHeight.value, GAP.value)
                val cellWidth = (maxWidth - GAP * (grid.columns - 1)) / grid.columns
                val cellHeight = (maxHeight - GAP * (grid.rows - 1)) / grid.rows
                LookaheadScope {
                    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(GAP, Alignment.CenterVertically)) {
                        page.chunked(grid.columns).forEach { row ->
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(GAP, Alignment.CenterHorizontally)) {
                                row.forEach { member ->
                                    key(member.id) {
                                        PersonTile(
                                            member = member,
                                            host = member.id == controllerId,
                                            pinned = member.id == pinned,
                                            onPin = { onPin(member.id) },
                                            modifier = Modifier
                                                .animateBounds(this@LookaheadScope, boundsTransform = BoundsSpring())
                                                .size(cellWidth, cellHeight),
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        if (pages.size > 1) PageDots(pages.size, pager.currentPage, Modifier.align(Alignment.CenterHorizontally).padding(bottom = 4.dp))
    }
}

@Composable
private fun PageDots(count: Int, current: Int, modifier: Modifier) {
    val c = Juntos.colors
    Row(modifier.height(12.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        repeat(count) { i ->
            val width by animateDpAsState(if (i == current) 18.dp else 6.dp, pop(), label = "dot")
            val color by animateColorAsState(if (i == current) c.text else c.textFaint, pop(), label = "dot-color")
            Box(Modifier.size(width, 6.dp).background(color, CircleShape))
        }
    }
}

@Composable
private fun PersonTile(member: Member, host: Boolean, pinned: Boolean, onPin: () -> Unit, modifier: Modifier) {
    val c = Juntos.colors
    val motion = LocalMotionEnabled.current
    val arrive = remember { Animatable(if (motion) 0f else 1f) }
    LaunchedEffect(Unit) { arrive.animateTo(1f, tween(JuntosMotion.POP_MS, easing = JuntosMotion.SpringPop)) }
    BoxWithConstraints(
        modifier
            .graphicsLayer { alpha = arrive.value.coerceIn(0f, 1f) }
            .clip(RoundedCornerShape(JuntosRadii.xl3))
            .background(if (member.cam == true) c.tile2 else c.tile),
    ) {
        Avatar(
            member.id,
            member.nickname,
            member.avatar,
            size = avatarSize(maxWidth, maxHeight),
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

private fun avatarSize(width: Dp, height: Dp): Dp = (minOf(width, height) * 0.42f).coerceIn(40.dp, 128.dp)


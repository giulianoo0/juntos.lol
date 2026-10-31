package lol.juntos.design

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** A track of options whose chip slides to the picked one with the spring. */
@Composable
fun <T> Segmented(
    options: List<T>,
    selected: T,
    onSelect: (T) -> Unit,
    label: (T) -> String,
    modifier: Modifier = Modifier,
    fill: Boolean = false,
) {
    val c = Juntos.colors
    val density = LocalDensity.current
    val bounds = remember { mutableStateMapOf<Int, Pair<Dp, Dp>>() }
    val index = options.indexOf(selected).coerceAtLeast(0)
    val target = bounds[index]
    val spec = pop<Dp>()
    val x by animateDpAsState(target?.first ?: 0.dp, spec, label = "chip-x")
    val w by animateDpAsState(target?.second ?: 0.dp, spec, label = "chip-w")
    Box(modifier.height(36.dp).background(c.segmentTrack, CircleShape).padding(3.dp)) {
        if (target != null) {
            Box(
                Modifier
                    .offset(x = x)
                    .width(w)
                    .fillMaxHeight()
                    .shadow(1.dp, CircleShape)
                    .background(c.segmentChip, CircleShape),
            )
        }
        Row(Modifier.fillMaxHeight(), verticalAlignment = Alignment.CenterVertically) {
            options.forEachIndexed { i, option ->
                val on = i == index
                Box(
                    Modifier
                        .let { if (fill) it.weight(1f) else it }
                        .fillMaxHeight()
                        .onPlaced { coords ->
                            with(density) {
                                bounds[i] = coords.positionInParent().x.toDp() to coords.size.width.toDp()
                            }
                        }
                        .selectable(
                            selected = on,
                            interactionSource = remember { MutableInteractionSource() },
                            indication = null,
                            role = Role.Tab,
                            onClick = { onSelect(option) },
                        )
                        .padding(horizontal = 14.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        label(option),
                        color = if (on) c.text else c.textMuted,
                        fontSize = JuntosTextSize.sm,
                        fontWeight = FontWeight.Medium,
                        maxLines = 1,
                    )
                }
            }
        }
    }
}

package lol.juntos.design

import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.rememberTransition
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties

/**
 * Places the popup under its trigger (over it when there is no room), centred on it and
 * kept inside the window, and remembers where the trigger sits so the spring grows from it.
 */
internal class SpringPlacement(private val gap: Int, private val margin: Int) : PopupPositionProvider {
    var origin by mutableStateOf(TransformOrigin(0.5f, 0f))

    override fun calculatePosition(anchorBounds: IntRect, windowSize: IntSize, layoutDirection: LayoutDirection, popupContentSize: IntSize): IntOffset {
        val below = anchorBounds.bottom + gap
        val fitsBelow = below + popupContentSize.height <= windowSize.height - margin
        val y = if (fitsBelow) below else (anchorBounds.top - gap - popupContentSize.height).coerceAtLeast(margin)
        val maxX = (windowSize.width - margin - popupContentSize.width).coerceAtLeast(margin)
        val x = (anchorBounds.center.x - popupContentSize.width / 2).coerceIn(margin, maxX)
        val ox = if (popupContentSize.width == 0) 0.5f else ((anchorBounds.center.x - x).toFloat() / popupContentSize.width).coerceIn(0f, 1f)
        val next = TransformOrigin(ox, if (fitsBelow) 0f else 1f)
        if (next != origin) origin = next
        return IntOffset(x, y)
    }
}

/**
 * The lawcore spring popover: it grows out of its trigger from scale 0 and a blur with
 * `pop` (600 ms) and folds back into it with `settle` (360 ms). Back and a tap outside close it.
 * Uncontrolled unless [expanded] is given.
 */
@Composable
fun SpringPopover(
    trigger: @Composable (open: () -> Unit) -> Unit,
    modifier: Modifier = Modifier,
    expanded: Boolean? = null,
    onExpandedChange: (Boolean) -> Unit = {},
    width: Dp = 256.dp,
    content: @Composable (close: () -> Unit) -> Unit,
) {
    var own by remember { mutableStateOf(false) }
    val isOpen = expanded ?: own
    val set: (Boolean) -> Unit = { own = it; onExpandedChange(it) }
    val state = remember { MutableTransitionState(false) }
    state.targetState = isOpen
    val density = LocalDensity.current
    val placement = remember(density) { with(density) { SpringPlacement(8.dp.roundToPx(), 16.dp.roundToPx()) } }

    Box(modifier) {
        trigger { set(true) }
        if (state.currentState || state.targetState) {
            Popup(
                popupPositionProvider = placement,
                onDismissRequest = { set(false) },
                properties = PopupProperties(focusable = true),
            ) {
                SpringSurface(state, placement, width) { content { set(false) } }
            }
        }
    }
}

@Composable
private fun SpringSurface(state: MutableTransitionState<Boolean>, placement: SpringPlacement, width: Dp, content: @Composable () -> Unit) {
    val popSpec = pop<Float>()
    val settleSpec = settle<Float>()
    val motion = LocalMotionEnabled.current
    val transition = rememberTransition(state, label = "popover")
    val progress by transition.animateFloat(
        transitionSpec = { if (targetState) popSpec else settleSpec },
        label = "spring",
    ) { if (it) 1f else 0f }
    val shape = RoundedCornerShape(JuntosRadii.xl2)
    val c = Juntos.colors
    val blur = if (motion) (8f * (1f - progress).coerceIn(0f, 1f)).dp else 0.dp
    Column(
        Modifier
            .graphicsLayer {
                scaleX = progress
                scaleY = progress
                transformOrigin = placement.origin
                alpha = if (motion) 1f else progress
            }
            .springBlur(blur)
            .padding(12.dp)
            .shadow(24.dp, shape, ambientColor = c.text.copy(alpha = 0.2f), spotColor = c.text.copy(alpha = 0.2f))
            .width(width)
            .background(c.overlay, shape)
            .border(1.dp, c.line, shape)
            .padding(JuntosSpacing.s2),
    ) { content() }
}

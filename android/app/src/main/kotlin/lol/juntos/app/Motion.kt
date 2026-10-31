package lol.juntos.app

import androidx.compose.animation.AnimatedVisibilityScope
import androidx.compose.animation.BoundsTransform
import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.SharedTransitionScope
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import lol.juntos.design.JuntosMotion
import lol.juntos.design.LocalMotionEnabled

@OptIn(ExperimentalSharedTransitionApi::class)
val LocalSharedScope = compositionLocalOf<SharedTransitionScope?> { null }
val LocalNavScope = compositionLocalOf<AnimatedVisibilityScope?> { null }

/**
 * The element that opens a room, and the room itself, share these bounds: the room
 * zooms out of the button or card the way an iOS app opens out of its icon.
 */
@OptIn(ExperimentalSharedTransitionApi::class)
@Composable
fun Modifier.door(key: String?, corner: Dp): Modifier {
    val shared = LocalSharedScope.current ?: return this
    val nav = LocalNavScope.current ?: return this
    if (key == null) return this
    val motion = LocalMotionEnabled.current
    val transform = BoundsTransform { _, _ ->
        if (motion) tween(JuntosMotion.POP_MS, easing = JuntosMotion.SpringPop) else snap()
    }
    return with(shared) {
        this@door.sharedBounds(
            rememberSharedContentState(key),
            animatedVisibilityScope = nav,
            boundsTransform = transform,
            resizeMode = SharedTransitionScope.ResizeMode.RemeasureToBounds,
            clipInOverlayDuringTransition = OverlayClip(RoundedCornerShape(corner)),
        )
    }
}

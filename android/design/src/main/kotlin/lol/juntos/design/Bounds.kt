package lol.juntos.design

import androidx.compose.animation.BoundsTransform
import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable

/** Bounds that morph with `pop`, for shared elements and animateBounds; a snap without motion. */
@OptIn(ExperimentalSharedTransitionApi::class)
@Composable
@ReadOnlyComposable
fun BoundsSpring(): BoundsTransform {
    val motion = LocalMotionEnabled.current
    return BoundsTransform { _, _ -> if (motion) tween(JuntosMotion.POP_MS, easing = JuntosMotion.SpringPop) else snap() }
}

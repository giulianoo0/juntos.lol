package lol.juntos.design

import androidx.compose.animation.BoundsTransform
import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.BlurredEdgeTreatment
import androidx.compose.ui.draw.blur
import androidx.compose.ui.unit.Dp

/** Bounds that morph with `pop`, for shared elements and animateBounds; a snap without motion. */
/** The blur a spring starts from; unbounded so the float shadow is not cut into a box, and gone once it settles. */
fun Modifier.springBlur(radius: Dp): Modifier =
    if (radius.value < 0.5f) this else then(Modifier.blur(radius, BlurredEdgeTreatment.Unbounded))

@OptIn(ExperimentalSharedTransitionApi::class)
@Composable
@ReadOnlyComposable
fun BoundsSpring(): BoundsTransform {
    val motion = LocalMotionEnabled.current
    return BoundsTransform { _, _ -> if (motion) tween(JuntosMotion.POP_MS, easing = JuntosMotion.SpringPop) else snap() }
}

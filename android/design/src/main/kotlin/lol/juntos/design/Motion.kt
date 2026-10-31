package lol.juntos.design

import android.provider.Settings
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.TweenSpec
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.platform.LocalContext

/** A CSS `linear()` curve with evenly spaced stops, the way the site samples its springs. */
class LinearStopsEasing(private val stops: FloatArray) : Easing {
    override fun transform(fraction: Float): Float {
        if (fraction <= 0f) return stops.first()
        if (fraction >= 1f) return stops.last()
        val scaled = fraction * (stops.size - 1)
        val i = scaled.toInt()
        return stops[i] + (stops[i + 1] - stops[i]) * (scaled - i)
    }
}

object JuntosMotion {
    /** --ease-spring-pop: out of the trigger with a light bounce (600 ms). */
    val SpringPop: Easing = LinearStopsEasing(
        floatArrayOf(
            0f, 0.058f, 0.191f, 0.352f, 0.513f, 0.656f, 0.774f, 0.865f, 0.932f, 0.977f, 1.005f,
            1.021f, 1.027f, 1.028f, 1.026f, 1.022f, 1.017f, 1.013f, 1.009f, 1.006f, 1.003f,
            1.001f, 1f, 1f, 1f,
        ),
    )

    /** --ease-spring-settle: back without any bounce (360 ms). */
    val SpringSettle: Easing = LinearStopsEasing(
        floatArrayOf(
            0f, 0.073f, 0.222f, 0.382f, 0.527f, 0.648f, 0.742f, 0.814f, 0.868f, 0.907f, 0.935f,
            0.955f, 0.969f, 0.978f, 0.985f, 0.99f, 1f,
        ),
    )

    /** --ease-slide. */
    val Slide: Easing = LinearStopsEasing(
        floatArrayOf(
            0f, 0.047f, 0.156f, 0.29f, 0.427f, 0.553f, 0.663f, 0.754f, 0.826f, 0.882f, 0.923f,
            0.953f, 0.974f, 0.988f, 0.997f, 1.002f, 1.005f, 1.006f, 1.006f, 1.006f, 1.005f,
            1.004f, 1.003f, 1.003f, 1.002f, 1f,
        ),
    )

    val EaseOut: Easing = CubicBezierEasing(0.23f, 1f, 0.32f, 1f)
    val EaseInOut: Easing = CubicBezierEasing(0.77f, 0f, 0.175f, 1f)

    const val POP_MS = 600
    const val SETTLE_MS = 360
    const val SLIDE_MS = 450
    const val PRESS_MS = 140
    const val FAST_MS = 160
    const val BASE_MS = 220
    const val SLOW_MS = 320
}

/** False when the system's "remove animations" is on: every spec below snaps. */
val LocalMotionEnabled = compositionLocalOf { true }

@Composable
@ReadOnlyComposable
fun <T> pop(): FiniteAnimationSpec<T> =
    if (LocalMotionEnabled.current) tween(JuntosMotion.POP_MS, easing = JuntosMotion.SpringPop) else snap()

@Composable
@ReadOnlyComposable
fun <T> settle(): FiniteAnimationSpec<T> =
    if (LocalMotionEnabled.current) tween(JuntosMotion.SETTLE_MS, easing = JuntosMotion.SpringSettle) else snap()

@Composable
@ReadOnlyComposable
fun <T> slide(): FiniteAnimationSpec<T> =
    if (LocalMotionEnabled.current) tween(JuntosMotion.SLIDE_MS, easing = JuntosMotion.Slide) else snap()

fun <T> easeOut(durationMs: Int = JuntosMotion.BASE_MS): TweenSpec<T> = tween(durationMs, easing = JuntosMotion.EaseOut)

@Composable
fun systemMotionEnabled(): Boolean {
    val resolver = LocalContext.current.contentResolver
    return Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) != 0f
}

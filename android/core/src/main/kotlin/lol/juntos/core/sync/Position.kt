package lol.juntos.core.sync

import lol.juntos.core.model.PlayState
import kotlin.math.abs
import kotlin.math.max

/** Same threshold as web/src/player/position.ts. */
const val DRIFT_THRESHOLD_MS = 450L

fun expectedPositionMs(state: PlayState, nowServerMs: Long): Long {
    val elapsed = if (state.playing) ((nowServerMs - state.serverTimeMs) * state.rate).toLong() else 0L
    return max(0L, state.positionMs + elapsed)
}

fun needsResync(localMs: Long, expectedMs: Long): Boolean = abs(localMs - expectedMs) > DRIFT_THRESHOLD_MS

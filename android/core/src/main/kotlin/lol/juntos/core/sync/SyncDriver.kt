package lol.juntos.core.sync

import lol.juntos.core.model.PlayState

/** What the sync drives: the player, in room time (the media offset already applied). */
interface PlaybackTarget {
    val positionMs: Long
    val playing: Boolean
    val buffering: Boolean
    fun seekTo(positionMs: Long)
    fun play()
    fun pause()
    fun setRate(rate: Float)
}

/** Applies the room's play state to the player, as applyState in useSync.ts does. */
class SyncDriver(
    private val target: PlaybackTarget,
    private val now: () -> Long = System::currentTimeMillis,
) {
    fun apply(state: PlayState, serverOffsetMs: Long) {
        val expected = expectedPositionMs(state, now() + serverOffsetMs)
        if (!target.buffering && needsResync(target.positionMs, expected)) target.seekTo(expected)
        target.setRate(state.rate.toFloat().takeIf { it > 0f } ?: 1f)
        if (state.playing && !target.playing) target.play()
        if (!state.playing && target.playing) target.pause()
    }
}

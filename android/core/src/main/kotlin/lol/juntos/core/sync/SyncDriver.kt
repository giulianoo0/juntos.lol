package lol.juntos.core.sync

import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
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

/**
 * Keeps the player on the room for as long as the caller runs: on every play state the socket
 * brings and, while playing, every [everyMs] after it, since drift creeps in between commands.
 * Runs on the caller's thread, which is the player's.
 */
suspend fun SyncDriver.follow(session: SyncSession, everyMs: Long = 5_000) {
    val driver = this
    coroutineScope {
        launch {
            session.state.map { it.playState }.distinctUntilChanged().filterNotNull()
                .collect { driver.apply(it, session.state.value.serverOffsetMs) }
        }
        while (true) {
            delay(everyMs)
            val now = session.state.value
            now.playState?.takeIf { it.playing }?.let { driver.apply(it, now.serverOffsetMs) }
        }
    }
}

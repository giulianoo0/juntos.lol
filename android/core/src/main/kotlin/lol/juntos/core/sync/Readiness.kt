package lol.juntos.core.sync

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Reports readiness as the site does: with every heartbeat, and every second while the room
 * waits for everyone to buffer (straight away when the wait starts). Runs until cancelled, on the
 * caller's thread, so [measure] may read the player; it returns null while nothing is loaded.
 */
suspend fun SyncSession.reportReadiness(
    measure: () -> ReadyReport?,
    everyMs: Long = 5_000,
    waitingEveryMs: Long = 1_000,
) {
    while (true) {
        measure()?.let(::ready)
        val waiting = state.value.waiting != null
        withTimeoutOrNull(if (waiting) waitingEveryMs else everyMs) {
            state.first { (it.waiting != null) != waiting }
        }
    }
}

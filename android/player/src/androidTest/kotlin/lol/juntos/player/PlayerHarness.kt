package lol.juntos.player

import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout

/** Where android/scripts/codec-clips' output is served: the Mac's http.server, seen from the emulator. */
val clipsBase: String =
    InstrumentationRegistry.getArguments().getString("clips") ?: "http://10.0.2.2:8077"

fun <T> onMain(block: () -> T): T {
    var result: Result<T>? = null
    InstrumentationRegistry.getInstrumentation().runOnMainSync { result = runCatching(block) }
    return result!!.getOrThrow()
}

fun newPlayer(): Media3Player = onMain {
    Media3Player(InstrumentationRegistry.getInstrumentation().targetContext)
}

fun <T> Flow<T>.awaitFirst(timeoutMs: Long, predicate: (T) -> Boolean): T {
    var last: T? = null
    return try {
        runBlocking { withTimeout(timeoutMs) { first { last = it; predicate(it) } } }
    } catch (e: TimeoutCancellationException) {
        throw AssertionError("timed out after $timeoutMs ms; last seen: $last")
    }
}

/** Ready and moving: the clock has left zero and nothing is loading. */
fun Media3Player.awaitPlaying(timeoutMs: Long = 20_000): PlayerSnapshot =
    snapshot.awaitFirst(timeoutMs) { it.error != null || (it.playing && !it.buffering && it.decodedFrames > 0) }

package lol.juntos.player

import android.util.Log
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/** A real room's HLS from the local stack: `-e roomMaster <url>` from android/scripts/room-hls.mjs. */
class RoomHlsTest {
    private val master: String? = InstrumentationRegistry.getArguments().getString("roomMaster")
    private val player = newPlayer()

    @After
    fun release() = onMain { player.release() }

    @Test
    fun aRoomOfTheLocalStackPlays() {
        assumeTrue("no -e roomMaster", master != null)
        onMain {
            player.load(MediaSource(master!!))
            player.play()
        }
        val started = player.awaitPlaying(30_000)
        assertNull(started.error)
        val after = player.snapshot.awaitFirst(4_000) { it.error != null || it.positionMs - started.positionMs >= 2_000 }
        assertNull(after.error)
        assertTrue(after.positionMs - started.positionMs >= 2_000)
        Log.i("RoomHls", "codec=${after.videoCodec} decoder=${after.videoDecoder} audio=${after.audio.map { it.label }} qualities=${after.qualities.map { it.label }}")
    }
}

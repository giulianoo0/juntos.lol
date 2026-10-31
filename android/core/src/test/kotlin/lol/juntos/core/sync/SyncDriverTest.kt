package lol.juntos.core.sync

import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import lol.juntos.core.fake.FakeSyncSession
import lol.juntos.core.model.PlayState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncDriverTest {
    private class Target(override var positionMs: Long = 0, override var playing: Boolean = false) : PlaybackTarget {
        override var buffering = false
        val seeks = mutableListOf<Long>()
        override fun seekTo(positionMs: Long) { seeks += positionMs; this.positionMs = positionMs }
        override fun play() { playing = true }
        override fun pause() { playing = false }
        override fun setRate(rate: Float) {}
    }

    @Test
    fun `a viewer far from the room jumps to where the room is now and plays`() {
        val target = Target(positionMs = 10_000)
        SyncDriver(target, now = { 5_000 }).apply(PlayState(playing = true, positionMs = 60_000, serverTimeMs = 4_000), serverOffsetMs = 0)
        assertEquals(listOf(61_000L), target.seeks)
        assertTrue(target.playing)
    }

    @Test
    fun `a viewer within the drift threshold is left where it is`() {
        val target = Target(positionMs = 60_300, playing = true)
        SyncDriver(target, now = { 4_000 }).apply(PlayState(playing = true, positionMs = 60_000, serverTimeMs = 4_000), serverOffsetMs = 0)
        assertEquals(emptyList<Long>(), target.seeks)
    }

    @Test
    fun `a follower plays and pauses with the room and is pulled back on the next beat when it drifts`() = runTest {
        val target = Target()
        val session = FakeSyncSession(SessionRequest("ROOM1", "Ana"), now = { 0 })
        backgroundScope.launch { SyncDriver(target, now = { 0 }).follow(session) }
        runCurrent()
        session.play(10_000)
        runCurrent()
        assertTrue(target.playing)
        assertEquals(10_000L, target.positionMs)
        target.positionMs = 14_000
        advanceTimeBy(5_001)
        assertEquals(10_000L, target.positionMs)
        session.pause(12_000)
        runCurrent()
        assertFalse(target.playing)
        assertEquals(12_000L, target.positionMs)
    }
}

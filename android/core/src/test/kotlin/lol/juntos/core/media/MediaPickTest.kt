package lol.juntos.core.media

import lol.juntos.core.model.MediaRegion
import lol.juntos.core.model.RoomInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MediaPickTest {
    private fun r(n: Int, startMs: Long, producedMs: Long, growing: Boolean = false) = MediaRegion(n, startMs, producedMs, growing)
    private val map = listOf(r(0, 0, 24_000), r(1, 599_600, 40_000), r(2, 23_900, 200_000, growing = true))

    @Test
    fun `the region holding the time wins, newest start first`() {
        assertEquals(0, regionFor(map, 10_000, null))
        assertEquals(1, regionFor(map, 610_000, null))
        assertEquals(2, regionFor(map, 100_000, null))
        assertEquals(2, regionFor(map, 23_950, null))
    }

    @Test
    fun `the loaded region is kept while it still holds the time`() {
        assertEquals(0, regionFor(map, 23_950, 0))
        assertEquals(2, regionFor(map, 30_000, 0))
    }

    @Test
    fun `a growing region reaches ahead of what it produced`() {
        assertEquals(2, regionFor(map, 240_000, null))
        assertEquals(2, regionFor(map, 400_000, null))
    }

    @Test
    fun `a hole with nothing growing keeps the loaded region, or the last one`() {
        val finished = listOf(r(0, 0, 24_000), r(1, 599_600, 40_000))
        assertEquals(0, regionFor(finished, 300_000, 0))
        assertEquals(1, regionFor(finished, 300_000, null))
        assertNull(regionFor(emptyList(), 0, null))
    }

    @Test
    fun `only a room without regions reloads on the media version`() {
        assertEquals(0, reloadVersion(r(2, 0, 1, growing = true), 37))
        assertEquals(0, reloadVersion(r(0, 0, 1), 512))
        assertEquals(4, reloadVersion(null, 4))
        assertEquals(0, reloadVersion(null, null))
    }

    @Test
    fun `a region room plays the region's master from the region's start`() {
        val room = RoomInfo(id = "AB12", mediaGeneration = 3, mediaVersion = 9, mediaRegions = map, mediaKey = "k y")
        val pick = mediaPick("https://juntos.lol/", room, positionMs = 610_000)
        assertEquals("https://juntos.lol/media/AB12/k/k%20y/hls/r1_master.m3u8?g=3&v=0", pick.masterUrl)
        assertEquals(599_600L, pick.offsetMs)
        assertEquals(1, pick.regionN)
    }

    @Test
    fun `a room without regions plays the plain master at its offset and version`() {
        val room = RoomInfo(id = "AB12", mediaGeneration = 1, mediaVersion = 4, mediaOffsetMs = 1_500)
        val pick = mediaPick("http://10.0.2.2:8090", room, positionMs = 0)
        assertEquals("http://10.0.2.2:8090/media/AB12/hls/master.m3u8?g=1&v=4", pick.masterUrl)
        assertEquals(1_500L, pick.offsetMs)
        assertNull(pick.regionN)
    }
}

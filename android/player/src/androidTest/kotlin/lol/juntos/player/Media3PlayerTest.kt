package lol.juntos.player

import androidx.media3.common.MimeTypes
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class Media3PlayerTest {
    private val player = newPlayer()
    private val rich = "$clipsBase/rich"

    @After
    fun release() = onMain { player.release() }

    private fun loadRich(source: MediaSource = MediaSource("$rich/master.m3u8"), startAtMs: Long = source.offsetMs) {
        onMain {
            player.load(source, startAtMs)
            player.play()
        }
        player.awaitPlaying()
    }

    @Test
    fun roomTimeIsPlayerTimePlusTheRegionOffset() {
        loadRich(MediaSource("$rich/master.m3u8", offsetMs = 60_000), startAtMs = 63_000)
        val position = onMain { player.positionMs }
        assertTrue("at $position", position in 63_000..65_000)

        onMain { player.seekTo(66_000) }
        val after = player.snapshot.awaitFirst(10_000) { !it.buffering && it.positionMs >= 66_000 }
        assertTrue("at ${after.positionMs}", after.positionMs < 68_000)
    }

    @Test
    fun audioTracksReadInPortugueseAndSwitch() {
        loadRich()
        val first = player.snapshot.awaitFirst(5_000) { it.audio.size == 2 }
        assertEquals(listOf("Português", "Inglês"), first.audio.map { it.label })
        assertTrue(first.audio[0].selected)

        onMain { player.selectAudio(1) }
        val switched = player.snapshot.awaitFirst(5_000) { it.audio.getOrNull(1)?.selected == true }
        assertEquals("en", switched.audio[1].language)
    }

    @Test
    fun subtitlesFromTheMasterAndSidecarsAreOfferedAndShown() {
        loadRich(
            MediaSource(
                "$rich/master.m3u8",
                sidecarSubtitles = listOf(
                    SidecarSubtitle("$rich/side.vtt", "pt", "Fora", MimeTypes.TEXT_VTT),
                    SidecarSubtitle("$rich/side.ass", "pt", "ASS", MimeTypes.TEXT_SSA),
                ),
            ),
        )
        val offered = player.snapshot.awaitFirst(5_000) { it.subtitles.size == 3 }
        assertEquals(setOf("Português", "Fora", "ASS"), offered.subtitles.map { it.label }.toSet())
        assertTrue(offered.subtitles.none { it.selected })

        val sidecar = offered.subtitles.first { it.label == "Fora" }
        onMain { player.selectSubtitle(sidecar.index) }
        player.cues.awaitFirst(10_000) { cues -> cues.any { it.text?.toString() == "Legenda de fora" } }

        val master = offered.subtitles.first { it.label == "Português" }
        onMain { player.selectSubtitle(master.index) }
        player.cues.awaitFirst(10_000) { cues -> cues.any { it.text?.toString() == "Legenda do master" } }

        val ass = offered.subtitles.first { it.label == "ASS" }
        onMain { player.selectSubtitle(ass.index) }
        player.cues.awaitFirst(10_000) { cues -> cues.any { it.text?.toString() == "Legenda ASS" } }

        onMain { player.selectSubtitle(null) }
        player.cues.awaitFirst(5_000) { it.isEmpty() }
        assertTrue(player.snapshot.value.subtitles.none { it.selected })
    }

    @Test
    fun aPinnedQualityPlaysThatHeightAndAutoLetsGo() {
        loadRich()
        val offered = player.snapshot.awaitFirst(5_000) { it.qualities.size == 2 }
        assertEquals(listOf("720p", "360p"), offered.qualities.map { it.label })

        onMain { player.selectQuality(offered.qualities[1].index) }
        player.snapshot.awaitFirst(15_000) { onMain { player.videoFormat?.height } == 360 }
        assertTrue(player.snapshot.value.qualities[1].selected)

        onMain { player.selectQuality(null) }
        player.snapshot.awaitFirst(5_000) { s -> s.qualities.none { it.selected } }
    }

    @Test
    fun anUnreachableMasterReportsAnError() {
        onMain {
            player.load(MediaSource("$clipsBase/nope/master.m3u8"))
            player.play()
        }
        val failed = player.snapshot.awaitFirst(15_000) { it.error != null }
        assertNotNull(failed.error)
    }
}

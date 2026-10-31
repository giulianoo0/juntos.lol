package lol.juntos.player

import androidx.media3.common.MimeTypes
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
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
    fun aDecoderThatTakesTheStreamAndGivesNothingBackIsSwappedForTheNext() {
        // Past its first segment the clip opens each one on an I-frame that is not an IDR, as YouTube's H.264 does.
        onMain {
            player.load(MediaSource("$clipsBase/h264-open-gop/master.m3u8"), startAtMs = 4_500)
            player.play()
        }
        val playing = player.awaitPlaying(timeoutMs = 30_000)
        assertNull(playing.error)
        assertTrue("at ${playing.positionMs}", playing.positionMs >= 4_500)
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

    private fun showing(text: String, timeoutMs: Long = 10_000) =
        player.cues.awaitFirst(timeoutMs) { cues -> cues.any { it.text.text == text } }

    private val sidecars = listOf(
        SidecarSubtitle("$rich/side.vtt", "pt", "Fora", MimeTypes.TEXT_VTT),
        SidecarSubtitle("$rich/side.ass", "en", "ASS", MimeTypes.TEXT_SSA),
    )

    @Test
    fun theRoomSidecarsAreOfferedAndDrawnFromTheirOwnCues() {
        loadRich(MediaSource("$rich/master.m3u8", sidecarSubtitles = sidecars))
        val offered = player.snapshot.awaitFirst(5_000) { it.subtitles.size == 2 }
        assertEquals(listOf("Fora", "ASS"), offered.subtitles.map { it.label })
        assertTrue(offered.subtitles.none { it.selected })

        onMain { player.selectSubtitle(0) }
        showing("Legenda de fora")
        onMain { player.selectSubtitle(1) }
        showing("Legenda ASS")

        onMain { player.selectSubtitle(null) }
        player.cues.awaitFirst(5_000) { it.isEmpty() }
        assertTrue(player.snapshot.value.subtitles.none { it.selected })
    }

    @Test
    fun aSubtitleTheRoomGainsMidwayIsOfferedWithoutReloadingAndThePickStays() {
        loadRich(MediaSource("$rich/master.m3u8", sidecarSubtitles = sidecars.take(1)))
        player.snapshot.awaitFirst(5_000) { it.subtitles.size == 1 }
        onMain { player.selectSubtitle(0); player.play() }
        showing("Legenda de fora")
        val playing = player.snapshot.awaitFirst(5_000) { it.playing && it.positionMs > 500 }.positionMs

        onMain { player.setSidecarSubtitles(sidecars) }
        val offered = player.snapshot.awaitFirst(5_000) { it.subtitles.size == 2 }
        assertEquals(listOf("Fora", "ASS"), offered.subtitles.map { it.label })
        assertTrue(offered.subtitles.single { it.label == "Fora" }.selected)
        assertTrue("kept playing from $playing", player.snapshot.value.positionMs >= playing)
    }

    @Test
    fun anImportedFileIsSelectedAndShownAboveIndexOneThousand() {
        loadRich()
        val index = onMain { player.importSubtitle("minha.srt", "1\n00:00:00,000 --> 00:00:10,000\n<i>Importada</i>\n") }
        assertEquals(1000, index)
        val snap = player.snapshot.awaitFirst(2_000) { s -> s.subtitles.any { it.index == 1000 && it.selected } }
        assertEquals("minha.srt", snap.subtitles.single { it.index == 1000 }.label)
        showing("Importada")
    }

    @Test
    fun aFileWithoutCuesIsNotImported() {
        loadRich()
        assertNull(onMain { player.importSubtitle("vazia.srt", "nada aqui") })
        assertTrue(player.snapshot.value.subtitles.isEmpty())
    }

    @Test
    fun withTwoSecondsOfDelayTheCueAppearsTwoSecondsLater() {
        onMain {
            player.load(MediaSource("$rich/master.m3u8"))
            player.importSubtitle("atraso.srt", "1\n00:00:01,000 --> 00:00:02,000\nAgora\n")
            player.setSubtitleDelay(2_000)
            player.play()
        }
        assertEquals(2_000, player.snapshot.awaitFirst(2_000) { it.subtitleDelayMs == 2_000L }.subtitleDelayMs)
        showing("Agora")
        val at = player.snapshot.value.positionMs
        assertTrue("shown at $at", at in 2_900..4_300)
    }

    @Test
    fun audioSubtitleAndDelayOutliveALoadOfAnotherRegion() {
        loadRich(MediaSource("$rich/master.m3u8", sidecarSubtitles = sidecars))
        player.snapshot.awaitFirst(5_000) { it.audio.size == 2 && it.subtitles.size == 2 }
        onMain {
            player.selectAudio(1)
            player.selectSubtitle(1)
            player.setSubtitleDelay(-500)
        }
        player.snapshot.awaitFirst(5_000) { it.audio[1].selected }

        val again = sidecars.map { it.copy(url = it.url + "?region=2") }.reversed()
        loadRich(MediaSource("$rich/master.m3u8", offsetMs = 30_000, sidecarSubtitles = again), startAtMs = 30_000)
        val after = player.snapshot.awaitFirst(10_000) { s -> s.audio.size == 2 && s.audio[1].selected && s.subtitles.any { it.selected } }
        assertEquals("en", after.subtitles.single { it.selected }.language)
        assertEquals(-500L, after.subtitleDelayMs)
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

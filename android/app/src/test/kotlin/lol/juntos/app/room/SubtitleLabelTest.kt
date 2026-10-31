package lol.juntos.app.room

import lol.juntos.core.model.MediaRegion
import lol.juntos.core.model.RoomInfo
import lol.juntos.core.model.RoomPreparation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SubtitleLabelTest {
    @Test
    fun `a title that is only the English name of its language reads in Portuguese`() {
        assertEquals("Português", subtitleLabel("Portuguese", "pt"))
        assertEquals("Alemão", subtitleLabel("German", "de"))
        assertEquals("Japonês", subtitleLabel("", "ja"))
    }

    @Test
    fun `a release's coded names read as languages with their region`() {
        assertEquals("Português (Brasil)", subtitleLabel("NF_Portuguese(Brazil)", "por"))
        assertEquals("Espanhol (América Latina)", subtitleLabel("NF_Spanish(Latin_America)", "spa"))
        assertEquals("Japonês (CC)", subtitleLabel("NF_Japanese(CC)", "jpn"))
        assertEquals("Norueguês", subtitleLabel("NF_Norwegian", "nob"))
        assertEquals("Inglês (automática)", subtitleLabel("English (auto-generated)", "en"))
    }

    @Test
    fun `any other title is kept`() {
        assertEquals("Comentários do diretor", subtitleLabel("Comentários do diretor", "pt"))
        assertEquals("Signs & Songs", subtitleLabel("Signs & Songs", "eng"))
    }

    @Test
    fun `Brazilian Portuguese tops the list, then Portugal's, then the rest`() {
        assertEquals(listOf(0, 1, 2), listOf("por" to "NF_Portuguese(Brazil)", "por" to "NF_Portuguese", "eng" to "NF_English").map { (l, t) -> subtitleRank(l, t) })
    }

    private val room = RoomInfo(id = "r", status = "local")

    @Test
    fun `a guest waits on the bucket while the host plays its cache as soon as it has frames`() {
        assertEquals(StageStatus.Preparing, stageStatus(room, hostRegions = null))
        assertEquals(StageStatus.Preparing, stageStatus(room, listOf(MediaRegion(0, 0, 0, growing = true))))
        assertEquals(StageStatus.Ready, stageStatus(room, listOf(MediaRegion(0, 0, 4_000, growing = true))))
        assertEquals(StageStatus.Empty, stageStatus(room.copy(status = "empty"), null))
    }

    @Test
    fun `the bar runs the room's length, else what the host probed`() {
        assertEquals(1_440_000, timelineMs(room.copy(durationMs = 1_440_000), 1_000))
        assertEquals(1_000, timelineMs(room.copy(durationMs = 0), 1_000))
        assertEquals(0, timelineMs(room, null))
    }

    @Test
    fun `a place no region holds is being prepared, a slow one says the buffer left`() {
        val regions = listOf(MediaRegion(0, 0, 60_000, growing = false))
        assertEquals("Preparando essa parte do vídeo…", waitText(600_000, regions, 0, 0))
        assertNull(waitText(10_000, regions, 1_000, 0))
        assertEquals("Carregando 7s de buffer", waitText(10_000, regions, 4_000, 3_200))
    }

    @Test
    fun `the preview's share counts what arrived against what it needs`() {
        assertEquals(0.5f, preparationProgress(RoomPreparation(receivedBytes = 50, previewTargetBytes = 100))!!, 0.001f)
        assertNull(preparationProgress(RoomPreparation(previewPhase = "receiving")))
    }

    @Test
    fun `the wait ends when it can play, and at the whole file only when there is no preview`() {
        assertEquals(PrepTarget(100, untilPlayable = true), prepTarget(RoomPreparation(sourceBytes = 1_000, previewTargetBytes = 100)))
        assertEquals(PrepTarget(1_000, untilPlayable = false), prepTarget(RoomPreparation(sourceBytes = 1_000, previewTargetBytes = 100, previewPhase = "unavailable")))
        assertEquals(PrepTarget(16_000_000, untilPlayable = true), prepTarget(RoomPreparation(sourceBytes = 1_440_000_000), durationMs = 1_440_000))
        assertEquals(PrepTarget(0, untilPlayable = true), prepTarget(RoomPreparation(sourceBytes = 1_440_000_000)))
    }

    @Test
    fun `the time left reads in minutes and hours, and says nothing while the rate is too thin`() {
        val mb = 1_048_576L
        assertNull(etaSeconds(0, 100 * mb, 1_000.0))
        assertEquals("menos de 1 min", etaLabel(etaSeconds(0, 30 * mb, mb.toDouble()), arrived = false))
        assertEquals("~4 min", etaLabel(etaSeconds(0, 240 * mb, mb.toDouble()), arrived = false))
        assertEquals("~2 h", etaLabel(etaSeconds(0, 7_200 * mb, mb.toDouble()), arrived = false))
        assertEquals("quase lá", etaLabel(etaSeconds(100, 100, mb.toDouble()), arrived = true))
    }

    @Test
    fun `speed and size read with a Brazilian decimal comma`() {
        assertEquals("3,5 MB/s", megabytesPerSecond(3_670_016))
        assertEquals("1,50 GB", byteSize(1_610_612_736))
        assertEquals("12 MB", byteSize(12_582_912))
    }

    @Test
    fun `a hosted torrent plays once it has the first sixteen seconds at the file's bitrate`() {
        assertEquals(16_000_000L, firstPlayBytes(1_440_000_000, 1_440_000))
        assertEquals(1_000L, firstPlayBytes(1_000, 8_000))
        val prep = hostPreparation(lol.juntos.core.model.SwarmStats(haveBytes = 4_000_000, selectedBytes = 1_440_000_000), 1_440_000)!!
        assertEquals(0.25f, preparationProgress(prep)!!, 0.001f)
        assertNull(hostPreparation(lol.juntos.core.model.SwarmStats(selectedBytes = 1_000), durationMs = 0))
    }
}

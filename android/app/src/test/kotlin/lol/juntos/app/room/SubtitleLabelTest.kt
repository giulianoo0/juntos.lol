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
}

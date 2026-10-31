package lol.juntos.core.media

import lol.juntos.core.model.RoomInfo
import lol.juntos.core.model.TrackInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SubtitleUrlTest {
    private val room = RoomInfo(id = "ABCD1234", mediaBaseUrl = "https://media.juntos.lol/rooms/ABCD1234/g3", mediaGeneration = 3, subsVersion = 7)

    @Test
    fun `a room subtitle is the bucket's vtt, versioned by its digest or the room's subtitles`() {
        assertEquals(
            "https://media.juntos.lol/rooms/ABCD1234/g3/subs/sub_2_pt-BR.vtt?g=3&s=ab12",
            subtitleUrl(room, TrackInfo(index = 2, language = "pt-BR", digest = "ab12")),
        )
        assertEquals("https://media.juntos.lol/rooms/ABCD1234/g3/subs/sub_1000_und.vtt?g=3&s=7", subtitleUrl(room, TrackInfo(index = 1000, language = "pt/../x")))
    }

    @Test
    fun `there is no subtitle before the bucket is known`() {
        assertNull(subtitleUrl(room.copy(mediaBaseUrl = null), TrackInfo(index = 0, language = "en")))
    }
}

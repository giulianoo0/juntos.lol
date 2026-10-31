package lol.juntos.player

import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Test

class SubtitleSizeTest {
    @Test
    fun `a phone's short stage keeps the site's 13 dp floor, a picture-in-picture window goes down to 8`() {
        assertEquals(13.dp, subtitleFontSize(221.dp))
        assertEquals(8.dp, subtitleFontSize(135.dp, pictureInPicture = true))
    }

    @Test
    fun `a tall picture grows its subtitles with it`() {
        assertEquals(18.dp, subtitleFontSize(400.dp))
    }
}

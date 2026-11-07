package lol.juntos.app

import lol.juntos.app.extensions.subtitleAsVtt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ExtensionSubtitlesTest {
    @Test
    fun `an srt becomes the room's webvtt, italics and all`() {
        val srt = "1\r\n00:00:01,500 --> 00:00:03,000\r\n<i>Olá</i> & tchau\r\n\r\n2\r\n01:02:03,004 --> 01:02:04,000\r\nSegunda\r\nlinha\r\n"
        assertEquals(
            "WEBVTT\n\n00:00:01.500 --> 00:00:03.000\n<i>Olá</i> &amp; tchau\n\n01:02:03.004 --> 01:02:04.000\nSegunda\nlinha\n",
            subtitleAsVtt(srt),
        )
    }

    @Test
    fun `a file without a cue is no subtitle`() {
        assertNull(subtitleAsVtt("<html>not found</html>"))
    }
}

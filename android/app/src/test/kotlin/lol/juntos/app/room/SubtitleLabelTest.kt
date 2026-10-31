package lol.juntos.app.room

import org.junit.Assert.assertEquals
import org.junit.Test

class SubtitleLabelTest {
    @Test
    fun `a title that is only the English name of its language reads in Portuguese`() {
        assertEquals("Português", subtitleLabel("Portuguese", "pt"))
        assertEquals("Alemão", subtitleLabel("German", "de"))
        assertEquals("Japonês", subtitleLabel("", "ja"))
    }

    @Test
    fun `any other title is kept`() {
        assertEquals("English (auto-generated)", subtitleLabel("English (auto-generated)", "en"))
        assertEquals("Comentários do diretor", subtitleLabel("Comentários do diretor", "pt"))
    }
}

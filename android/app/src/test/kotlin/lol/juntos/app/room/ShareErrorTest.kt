package lol.juntos.app.room

import org.junit.Assert.assertEquals
import org.junit.Test

class ShareErrorTest {
    @Test
    fun `a magnet nobody answers says so instead of blaming the link`() {
        assertEquals("O torrent não respondeu. Tente de novo ou use outro magnet.", shareError("torrent metadata timed out: deadline has elapsed", "x"))
        assertEquals("O celular está sem espaço.", shareError("write: No space left on device (os error 28)", "x"))
        assertEquals("Esse magnet não é válido.", shareError("invalid_magnet", "x"))
    }

    @Test
    fun `anything else falls back to the step's own message`() {
        assertEquals("Não deu para começar esse arquivo.", shareError("HTTP 500", "Não deu para começar esse arquivo."))
    }
}

package lol.juntos.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TrackLabelsTest {
    @Test
    fun `three letter codes read in Portuguese`() {
        assertEquals("Português", languageLabel("por"))
        assertEquals("Japonês", languageLabel("jpn"))
        assertEquals("Alemão", languageLabel("ger"))
        assertEquals("Alemão", languageLabel("deu"))
    }

    @Test
    fun `two letter codes and a region suffix read as the language`() {
        assertEquals("Português", languageLabel("pt"))
        assertEquals("Português", languageLabel("pt-BR"))
        assertEquals("Inglês", languageLabel("en_US"))
    }

    @Test
    fun `Media3's macrolanguage form reads as the language inside it`() {
        assertEquals("Indonésio", languageLabel("ms-ind"))
        assertEquals("Sérvio", languageLabel("hbs-srp"))
        assertEquals("Espanhol", languageLabel("es-419"))
    }

    @Test
    fun `an unnameable tag gives no label`() {
        assertNull(languageLabel("und"))
        assertNull(languageLabel(""))
        assertNull(languageLabel("zzz"))
    }

    @Test
    fun `a name ffmpeg or the browser pipeline invented gives way to the language`() {
        assertEquals("Português", audioTrackLabel("audio_6", "por", 6))
        assertEquals("Inglês", audioTrackLabel("eng-2", "eng", 1))
        assertEquals("Português", audioTrackLabel("por-1", "pt", 0))
    }

    @Test
    fun `a name the encoder did not invent is kept`() {
        assertEquals("Comentários", audioTrackLabel("Comentários", "por", 1))
    }

    @Test
    fun `without a name the raw code then the position label the track`() {
        assertEquals("zzz", audioTrackLabel("audio_1", "zzz", 1))
        assertEquals("3", audioTrackLabel("audio_2", null, 2))
        assertEquals("1", audioTrackLabel(null, null, 0))
    }
}

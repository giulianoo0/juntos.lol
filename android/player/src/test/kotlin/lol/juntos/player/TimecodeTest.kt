package lol.juntos.player

import org.junit.Assert.assertEquals
import org.junit.Test

class TimecodeTest {
    @Test
    fun `seconds are padded and minutes are not`() {
        assertEquals("0:00", timecode(0))
        assertEquals("1:05", timecode(65_400))
    }

    @Test
    fun `minutes run past sixty rather than growing an hours field`() {
        assertEquals("75:03", timecode(4_503_000))
    }

    @Test
    fun `a negative time reads as zero`() {
        assertEquals("0:00", timecode(-500))
    }
}

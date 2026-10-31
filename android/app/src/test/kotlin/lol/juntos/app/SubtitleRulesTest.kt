package lol.juntos.app

import lol.juntos.app.room.decodeSubtitle
import lol.juntos.app.room.formatDelay
import lol.juntos.app.room.parseDelay
import lol.juntos.app.room.stepDelay
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SubtitleRulesTest {
    @Test
    fun `the delay reads with a comma and a sign only when it is not zero`() {
        assertEquals("0,00 s", formatDelay(0))
        assertEquals("+1,25 s", formatDelay(1_250))
        assertEquals("-1,50 s", formatDelay(-1_500))
    }

    @Test
    fun `a typed delay takes either decimal mark, in seconds`() {
        assertEquals(1_500L, parseDelay("1,5"))
        assertEquals(1_500L, parseDelay("1.5"))
        assertEquals(-250L, parseDelay("-0,25 s"))
        assertEquals(2_000L, parseDelay("+2"))
        assertNull(parseDelay(""))
        assertNull(parseDelay("abc"))
    }

    @Test
    fun `the delay never goes past ten minutes either way`() {
        assertEquals(600_000L, parseDelay("9999"))
        assertEquals(-600_000L, stepDelay(-600_000, -1))
        assertEquals(250L, stepDelay(0, 1))
    }

    @Test
    fun `a subtitle file in utf-8 is read as is`() {
        assertEquals("ação", decodeSubtitle("ação".toByteArray(Charsets.UTF_8)))
    }

    @Test
    fun `a file that is not utf-8 falls back to windows-1252`() {
        assertEquals("ação", decodeSubtitle("ação".toByteArray(charset("windows-1252"))))
    }

    @Test
    fun `a file over two megabytes is refused`() {
        assertNull(decodeSubtitle(ByteArray(2 * 1024 * 1024 + 1) { 'a'.code.toByte() }))
    }
}

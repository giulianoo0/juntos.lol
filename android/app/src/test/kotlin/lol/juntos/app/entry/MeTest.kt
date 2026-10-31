package lol.juntos.app.entry

import lol.juntos.design.MascotKinds
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class MeTest {
    @Test
    fun `a name stops at the server's 64 bytes without cutting a character in half`() {
        assertEquals("ã".repeat(32), fitNickname("ã".repeat(40)))
        assertEquals("a".repeat(62), fitNickname("a".repeat(62) + "😀"))
        assertEquals("a".repeat(60) + "😀", fitNickname("a".repeat(60) + "😀😀"))
    }

    @Test
    fun `control characters pasted into the name are dropped`() {
        assertEquals("AnaBia", fitNickname("Ana\nBia\u0007"))
    }

    @Test
    fun `the room gets the name trimmed, and a guest name when only spaces were left`() {
        assertEquals("Ana", nicknameToEnter("  Ana "))
        assertTrue(Regex("Guest-[A-Za-z0-9]{6}").matches(nicknameToEnter("   ")))
    }

    @Test
    fun `every name the field lets through is one the server takes`() {
        for (typed in listOf("Ana", "ã".repeat(40), "😀".repeat(20), "x\ty")) assertTrue(typed, validNickname(nicknameToEnter(typed)))
        assertFalse(validNickname("   "))
        assertFalse(validNickname("a".repeat(65)))
    }

    @Test
    fun `a first run goes in as a random guest wearing the bowtie`() {
        val me = MeStore(MemoryPrefs(), Random(7)).load()
        assertTrue(Regex("Guest-[A-Za-z0-9]{6}").matches(me.nickname))
        assertTrue(me.avatar.removeSuffix(".bowtie") in MascotKinds)
    }

    @Test
    fun `the name and face picked at the door come back next time`() {
        val prefs = MemoryPrefs()
        MeStore(prefs).save(Me("Ana", "owl.crown"))
        assertEquals(Me("Ana", "owl.crown"), MeStore(prefs).load())
    }

    @Test
    fun `a kept pair the app cannot use is replaced by a random one`() {
        val prefs = MemoryPrefs()
        MeStore(prefs).save(Me("a".repeat(65), "dragon.crown"))
        val me = MeStore(prefs, Random(7)).load()
        assertTrue(me.nickname.startsWith("Guest-"))
        assertTrue(me.avatar.endsWith(".bowtie"))
    }
}

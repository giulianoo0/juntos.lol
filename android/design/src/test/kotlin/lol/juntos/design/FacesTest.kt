package lol.juntos.design

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FacesTest {
    @Test
    fun `a person's hue is the one the site picks for the same id`() {
        assertEquals(5, hueOf("me"))
        assertEquals(3, hueOf("ana"))
        assertEquals(7, hueOf("bob"))
        assertEquals(8, hueOf("xyz123"))
    }

    @Test
    fun `the initial is the first character raised`() {
        assertEquals("A", initialOf("  ana"))
        assertEquals("?", initialOf("   "))
    }

    @Test
    fun `the mascot comes from the avatar's kind, colour and accessory aside`() {
        assertEquals("fox", mascotKindOf("fox.bowtie"))
        assertEquals("cat", mascotKindOf("cat-preto.beanie"))
        assertEquals("owl", mascotKindOf("owl"))
    }

    @Test
    fun `an avatar the app does not know has no mascot`() {
        assertNull(mascotKindOf("dragon.crown"))
        assertNull(mascotKindOf(null))
    }
}

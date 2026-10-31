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
    fun `a mascot is written the way the site writes an avatar`() {
        assertEquals("fox.crown", Mascot("fox", "crown").avatar)
        assertEquals("owl", Mascot("owl", "none").avatar)
        assertEquals(Mascot("cat", "beanie"), mascotOf(Mascot("cat", "beanie").avatar))
    }

    @Test
    fun `every kind has a drawing for every accessory`() {
        for (kind in MascotKinds) assertEquals(kind, MascotAccessories.size, MASCOT_ART.getValue(kind).toSet().size)
    }

    @Test
    fun `a site colour is dropped and an accessory newer than the app is left off`() {
        assertEquals(Mascot("cat", "beanie"), mascotOf("cat-preto.beanie"))
        assertEquals(Mascot("fox", "none"), mascotOf("fox.jetpack"))
    }

    @Test
    fun `an avatar the app does not know has no mascot`() {
        assertNull(mascotKindOf("dragon.crown"))
        assertNull(mascotKindOf(null))
    }
}

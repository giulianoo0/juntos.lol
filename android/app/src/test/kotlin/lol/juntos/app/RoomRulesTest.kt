package lol.juntos.app

import lol.juntos.app.home.guestName
import lol.juntos.app.home.roomCodeFrom
import lol.juntos.app.room.tilesFor
import lol.juntos.core.model.Member
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class RoomRulesTest {
    @Test
    fun `a code is read out of a pasted link, raised to capitals`() {
        assertEquals("AB12CD34", roomCodeFrom("https://juntos.lol/room/ab12cd34?x=1"))
        assertEquals("AB12CD34", roomCodeFrom("  ab12cd34 "))
    }

    @Test
    fun `anything that is not eight letters and digits is no code`() {
        assertNull(roomCodeFrom("abc"))
        assertNull(roomCodeFrom("juntos.lol/room/AB12-D34"))
        assertNull(roomCodeFrom(""))
    }

    @Test
    fun `a guest is named like the site names one`() {
        assertTrue(guestName(Random(1)).matches(Regex("Guest-[A-Za-z0-9]{6}")))
    }

    private val ana = Member(id = "ana", nickname = "Ana")
    private val bia = Member(id = "bia", nickname = "Bia")
    private val caio = Member(id = "caio", nickname = "Caio")

    @Test
    fun `alone in the room the one tile takes the whole row`() {
        val tiles = tilesFor(listOf(ana), pinned = null)
        assertEquals(listOf("ana" to 2), tiles.map { it.member.id to it.span })
    }

    @Test
    fun `whoever turns the camera on moves ahead of those without one`() {
        val tiles = tilesFor(listOf(ana, bia, caio.copy(cam = true)), pinned = null)
        assertEquals(listOf("caio", "ana", "bia"), tiles.map { it.member.id })
    }

    @Test
    fun `the pinned person comes first across the whole row`() {
        val tiles = tilesFor(listOf(ana, bia.copy(cam = true), caio), pinned = "caio")
        assertEquals(listOf("caio" to 2, "bia" to 1, "ana" to 1), tiles.map { it.member.id to it.span })
    }

    @Test
    fun `a pin on someone who left is ignored`() {
        val tiles = tilesFor(listOf(ana, bia), pinned = "caio")
        assertEquals(listOf("ana" to 1, "bia" to 1), tiles.map { it.member.id to it.span })
    }
}

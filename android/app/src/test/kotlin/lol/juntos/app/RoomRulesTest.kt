package lol.juntos.app

import lol.juntos.app.home.guestName
import lol.juntos.app.home.roomCodeFrom
import lol.juntos.app.room.Grid
import lol.juntos.app.room.Hinge
import lol.juntos.app.room.RoomLayout
import lol.juntos.app.room.galleryOrder
import lol.juntos.app.room.gridFor
import lol.juntos.app.room.roomLayout
import lol.juntos.app.room.tilesPerPage
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
    fun `whoever turns the camera on moves ahead of those without one`() {
        assertEquals(listOf("caio", "ana", "bia"), galleryOrder(listOf(ana, bia, caio.copy(cam = true)), pinned = null).map { it.id })
    }

    @Test
    fun `the pinned person comes first, ahead of the cameras`() {
        assertEquals(listOf("caio", "bia", "ana"), galleryOrder(listOf(ana, bia.copy(cam = true), caio), pinned = "caio").map { it.id })
    }

    @Test
    fun `a pin on someone who left is ignored`() {
        assertEquals(listOf("ana", "bia"), galleryOrder(listOf(ana, bia), pinned = "caio").map { it.id })
    }

    @Test
    fun `a phone holds two tiles a page, a tablet four, a big screen six`() {
        assertEquals(listOf(2, 4, 6), listOf(411, 700, 900).map(::tilesPerPage))
    }

    @Test
    fun `two tiles stack on an upright phone and sit side by side on a lying one`() {
        assertEquals(Grid(1, 2), gridFor(2, width = 360f, height = 520f, gap = 8f))
        assertEquals(Grid(2, 1), gridFor(2, width = 800f, height = 280f, gap = 8f))
    }

    @Test
    fun `four tiles on a tablet make a square`() {
        assertEquals(Grid(2, 2), gridFor(4, width = 1000f, height = 700f, gap = 8f))
    }

    @Test
    fun `no grid leaves a whole row empty`() {
        val grid = gridFor(3, width = 900f, height = 900f, gap = 8f)
        assertTrue(grid.columns * (grid.rows - 1) < 3)
    }

    private val fold = Hinge(horizontal = true, halfOpened = true, separating = true)

    @Test
    fun `a room without a video is only the gallery, lying down or not`() {
        assertEquals(RoomLayout.Column, roomLayout(800, 360, 360, hasMedia = false, fullscreen = false, hinge = null))
        assertEquals(RoomLayout.Column, roomLayout(360, 800, 360, hasMedia = false, fullscreen = true, hinge = fold))
    }

    @Test
    fun `a video takes the screen of a lying phone and sits beside the gallery on a tablet`() {
        assertEquals(RoomLayout.Column, roomLayout(360, 800, 360, hasMedia = true, fullscreen = false, hinge = null))
        assertEquals(RoomLayout.Immersive, roomLayout(800, 360, 360, hasMedia = true, fullscreen = false, hinge = null))
        assertEquals(RoomLayout.Immersive, roomLayout(915, 411, 411, hasMedia = true, fullscreen = false, hinge = null))
        assertEquals(RoomLayout.Split, roomLayout(1280, 800, 800, hasMedia = true, fullscreen = false, hinge = null))
        assertEquals(RoomLayout.Column, roomLayout(800, 1280, 800, hasMedia = true, fullscreen = false, hinge = null))
    }

    @Test
    fun `a half closed foldable shows the video above the fold, an open book beside it`() {
        assertEquals(RoomLayout.Tabletop, roomLayout(840, 700, 800, hasMedia = true, fullscreen = false, hinge = fold))
        assertEquals(RoomLayout.Split, roomLayout(700, 840, 800, hasMedia = true, fullscreen = false, hinge = fold.copy(horizontal = false)))
    }
}

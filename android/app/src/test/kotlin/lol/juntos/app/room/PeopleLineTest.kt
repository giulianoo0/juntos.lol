package lol.juntos.app.room

import org.junit.Assert.assertEquals
import org.junit.Test

class PeopleLineTest {
    @Test
    fun `the room's line names up to four people and counts past that`() {
        assertEquals("Só você", peopleLine(listOf("Você")))
        assertEquals("Você e Ana", peopleLine(listOf("Você", "Ana")))
        assertEquals("Você, Ana e Bia", peopleLine(listOf("Você", "Ana", "Bia")))
        assertEquals("5 pessoas", peopleLine(listOf("Você", "Ana", "Bia", "Caio", "Duda")))
    }
}

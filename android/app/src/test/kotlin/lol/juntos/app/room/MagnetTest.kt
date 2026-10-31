package lol.juntos.app.room

import org.junit.Assert.assertEquals
import org.junit.Test

class MagnetTest {
    private val hash = "bdbb9f99153171cd0f27876e6b7d60dd64f9ff4b"

    @Test
    fun `an encoded xt goes to the room spelled out, its trackers kept`() {
        val pasted = "magnet:?xt=urn%3Abtih%3A$hash&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce"
        assertEquals("magnet:?xt=urn:btih:$hash&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce", roomMagnet(hash, pasted))
    }

    @Test
    fun `the name stays and addresses, local names and web seeds are dropped`() {
        val pasted = "magnet:?xt=urn:btih:$hash&dn=Meu+Filme&tr=udp://10.0.0.2:6969&tr=http://tracker.lan/a&tr=https://t.example.com/a&ws=http://evil.example.com/f"
        assertEquals("magnet:?xt=urn:btih:$hash&dn=Meu%20Filme&tr=https%3A%2F%2Ft.example.com%2Fa", roomMagnet(hash, pasted))
    }

    @Test
    fun `a base32 hash reads as hex, and a magnet without a hash is not one`() {
        val parsed = parseMagnet("magnet:?xt=urn:btih:XW5Z7GIVGFY42DZHQ5XGW7LA3VSPT72L&dn=x")!!
        assertEquals(hash, parsed.infoHash)
        assertEquals(null, parseMagnet("magnet:?dn=x"))
    }
}

package lol.juntos.core.extensions

import kotlinx.serialization.json.JsonPrimitive
import lol.juntos.core.JuntosJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProtocolTest {
    private fun manifest(media: List<String>) = Manifest("addons", "Addons", "1", "index.html", null, Hosts(emptyList(), emptyList(), media))

    private fun message(json: String, media: List<String> = listOf("*.cdn.exemplo.dev")) = parseMessage(JuntosJson.parseToJsonElement(json), manifest(media))

    @Test
    fun `a file plays with the headers the protocol allows, from a media host`() {
        val play = message("""{"juntos":1,"type":"play","title":"Filme","ref":"r1","source":{"kind":"file","url":"https://a.cdn.exemplo.dev/v.mp4","headers":{"Referer":"https://exemplo.dev/"}}}""")
        assertEquals(ExtMessage.Play("Filme", null, "r1", ExtSource.Media(false, "https://a.cdn.exemplo.dev/v.mp4", mapOf("referer" to "https://exemplo.dev/")), emptyList()), play)
    }

    @Test
    fun `a source off the media hosts, on this network or with another header is refused`() {
        assertNull(message("""{"juntos":1,"type":"play","title":"F","ref":"r","source":{"kind":"hls","url":"https://evil.dev/p.m3u8"}}"""))
        assertNull(message("""{"juntos":1,"type":"play","title":"F","ref":"r","source":{"kind":"hls","url":"http://192.168.0.2/p.m3u8"}}""", listOf("*")))
        assertNull(message("""{"juntos":1,"type":"play","title":"F","ref":"r","source":{"kind":"file","url":"https://a.cdn.exemplo.dev/v","headers":{"cookie":"x"}}}"""))
        assertNull(message("""{"juntos":2,"type":"close"}"""))
    }

    @Test
    fun `any host takes plain http on the internet, as the app reads it`() {
        assertTrue(mediaUrlAllowed("http://safira.example.store/movie/1.mp4", listOf("*")))
        assertFalse(mediaUrlAllowed("http://127.0.0.1:8080/x", listOf("*")))
        assertFalse(mediaUrlAllowed("https://user:pw@a.dev/x", listOf("*")))
        assertFalse(mediaUrlAllowed("http://a.dev/x.vtt", listOf("*"), https = true))
    }

    @Test
    fun `a torrent keeps its file and public trackers, and becomes a magnet`() {
        val play = message("""{"juntos":1,"type":"play","title":"Filme","ref":"r","source":{"kind":"torrent","infoHash":"B47882A62EEDEC7767AA86B7A866F1DD846C5357","fileIdx":2,"trackers":["udp://tracker.example.org:1337/announce","udp://10.0.0.1:80"]}}""")
        val source = (play as ExtMessage.Play).source as ExtSource.Torrent
        assertEquals(ExtSource.Torrent("b47882a62eedec7767aa86b7a866f1dd846c5357", 2, listOf("udp://tracker.example.org:1337/announce")), source)
        assertEquals(
            "magnet:?xt=urn:btih:b47882a62eedec7767aa86b7a866f1dd846c5357&dn=Um%20Filme&tr=udp%3A%2F%2Ftracker.example.org%3A1337%2Fannounce",
            torrentMagnet(source, "Um Filme"),
        )
    }

    @Test
    fun `init tells the extension it runs in the app`() {
        val init = initMessage(dark = true, vars = mapOf("--text" to "#fff"), locale = "pt-BR", canPlay = true)
        assertEquals(JsonPrimitive(true), init["app"])
        assertEquals(JsonPrimitive("init"), init["type"])
    }

    @Test
    fun `any host reaches every host, a wildcard only its subdomains`() {
        assertTrue(hostAllowed("x.y.dev", listOf("*")))
        assertTrue(hostAllowed("a.cdn.exemplo.dev", listOf("*.cdn.exemplo.dev")))
        assertFalse(hostAllowed("cdn.exemplo.dev", listOf("*.cdn.exemplo.dev")))
        assertFalse(hostAllowed("evilcdn.exemplo.dev", listOf("*.cdn.exemplo.dev")))
    }
}

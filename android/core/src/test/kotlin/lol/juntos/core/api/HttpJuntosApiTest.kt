package lol.juntos.core.api

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import lol.juntos.core.fake.FakeJuntosApi
import lol.juntos.core.human.TurnstileGate
import lol.juntos.core.model.Seat
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class HttpJuntosApiTest {
    @get:Rule val server = MockWebServer()
    private val storage = MemoryCookieStorage()
    private val jar = PersistentCookieJar(storage)
    private val base get() = server.url("/").toString()
    private fun api(cookies: PersistentCookieJar = jar) = HttpJuntosApi(base, juntosHttpClient(cookies, "JuntosApp/0.1.0"))

    @Test
    fun `creating a room posts the creator and its door, signed as the app`() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(201)
                .setBody("""{"id":"AB12CD34","ownerToken":"own","nickname":"Ana","name":"Filme","status":"empty","expiresAt":"2026-11-01T05:00:00Z"}"""),
        )
        val created = api().createRoom("Ana", "Filme", password = "segredo")
        assertEquals("AB12CD34", created.id)
        assertEquals("own", created.ownerToken)
        val request = server.takeRequest()
        assertEquals("POST /api/rooms", "${request.method} ${request.path}")
        assertEquals("JuntosApp/0.1.0", request.getHeader("User-Agent"))
        val body = buildJsonObject {
            put("nickname", JsonPrimitive("Ana"))
            put("name", JsonPrimitive("Filme"))
            put("joinMode", JsonPrimitive("password"))
            put("password", JsonPrimitive("segredo"))
        }
        assertEquals(body, Json.parseToJsonElement(request.body.readUtf8()))
    }

    @Test
    fun `a refusal carries the server's status and error code`() {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"bad_password"}"""))
        val refusal = assertThrows(ApiException::class.java) { runBlocking { api().join("AB12CD34", "errada") } }
        assertEquals(401, refusal.status)
        assertEquals("bad_password", refusal.code)
    }

    @Test
    fun `a locked room is read with the seat the socket gave`() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"id":"AB12CD34","status":"ready","joinMode":"password","durationMs":596000,"screens":[]}"""))
        val room = api().room("AB12CD34", Seat("m1", "cap1"))
        assertEquals(596_000L, room.durationMs)
        val request = server.takeRequest()
        assertEquals("/api/rooms/AB12CD34", request.path)
        assertEquals("m1", request.getHeader("X-Member-Id"))
        assertEquals("cap1", request.getHeader("X-Capability"))
    }

    @Test
    fun `the door names who is in`() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"name":"Filme","joinMode":"open","memberCount":2,"nicknames":["Ana","Bia"]}"""))
        val preview = api().preview("AB12CD34")
        assertEquals("AB12CD34", preview.id)
        assertEquals(listOf("Ana", "Bia"), preview.nicknames)
    }

    @Test
    fun `the day's human cookie outlives the jar that got it`() = runBlocking {
        server.enqueue(MockResponse().addHeader("Set-Cookie", "ss_human=1793000000.sig; Path=/; Max-Age=86400; HttpOnly").setBody("{}"))
        server.enqueue(MockResponse().setBody("""{"turnstileSiteKey":""}"""))
        api().verifyHuman("token")
        val reopened = PersistentCookieJar(storage)
        api(reopened).config()
        server.takeRequest()
        assertEquals("ss_human=1793000000.sig", server.takeRequest().getHeader("Cookie"))
    }

    @Test
    fun `the widget's token is spent once and the cookie answers after that`() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"turnstileSiteKey":"site-key"}"""))
        server.enqueue(MockResponse().addHeader("Set-Cookie", "ss_human=1.sig; Path=/; Max-Age=86400").setBody("{}"))
        val solvedFor = mutableListOf<String>()
        val gate = TurnstileGate(api(), jar, base) { siteKey -> solvedFor += siteKey; "token-1" }
        assertTrue(gate.ensure())
        assertTrue(gate.ensure())
        assertEquals(listOf("site-key"), solvedFor)
        assertEquals(2, server.requestCount)
        server.takeRequest()
        assertEquals("""{"token":"token-1"}""", server.takeRequest().body.readUtf8())
    }

    @Test
    fun `a server without Turnstile asks for nothing`() = runBlocking {
        val gate = TurnstileGate(FakeJuntosApi(), jar, base) { error("no widget without a site key") }
        assertTrue(gate.ensure())
    }
}

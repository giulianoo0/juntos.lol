package lol.juntos.core.account

import kotlinx.coroutines.runBlocking
import lol.juntos.core.JuntosJson
import lol.juntos.core.api.HttpJuntosApi
import lol.juntos.core.api.MemoryCookieStorage
import lol.juntos.core.api.PersistentCookieJar
import lol.juntos.core.api.juntosHttpClient
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class AccountsTest {
    @get:Rule val server = MockWebServer()
    private val storage = MemoryCookieStorage()
    private fun accounts(jar: PersistentCookieJar = PersistentCookieJar(storage)): Accounts {
        val base = server.url("/").toString()
        return Accounts(HttpJuntosApi(base, juntosHttpClient(jar, "JuntosApp/test")), jar, base)
    }
    private val session = MockResponse().setResponseCode(204).addHeader("Set-Cookie", "ss_account=tok; Path=/; Max-Age=2592000; HttpOnly")

    @Test
    fun `the browser starts with the verifier's hash, never the verifier`() {
        val verifier = newVerifier()
        assertEquals(43, verifier.length)
        val start = accounts().startUrl(verifier).toHttpUrl()
        assertEquals("/api/auth/app", start.encodedPath)
        assertEquals(challengeOf(verifier), start.queryParameter("challenge"))
        assertFalse(start.toString().contains(verifier))
        // RFC 7636's example pair, the same hash the server takes.
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
    }

    @Test
    fun `the code and its verifier turn into a session every later call carries, across restarts`() = runBlocking {
        server.enqueue(session)
        server.enqueue(MockResponse().setBody("""{"id":7,"nickname":"giuli","avatar":"fox.bowtie","stats":{}}"""))
        val accounts = accounts()

        assertTrue(accounts.signIn("code", "verifier"))

        val redeem = server.takeRequest()
        assertEquals("POST /api/auth/app/redeem", "${redeem.method} ${redeem.path}")
        assertEquals("""{"code":"code","verifier":"verifier"}""", JuntosJson.parseToJsonElement(redeem.body.readUtf8()).toString())
        assertEquals("ss_account=tok", server.takeRequest().getHeader("Cookie"))
        assertEquals("giuli", accounts.me.value?.nickname)

        server.enqueue(MockResponse().setBody("""{"id":7,"nickname":"giuli"}"""))
        val reopened = accounts()
        reopened.refresh()
        assertEquals(7L, reopened.me.value?.id)
    }

    @Test
    fun `a refused code signs nobody in`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"bad_code"}"""))
        val accounts = accounts()
        assertFalse(accounts.signIn("code", "verifier"))
        assertNull(accounts.me.value)
    }

    @Test
    fun `a session the server no longer knows is dropped, and one it cannot check is kept`() = runBlocking {
        val jar = PersistentCookieJar(storage)
        server.enqueue(session)
        server.enqueue(MockResponse().setResponseCode(503))
        accounts(jar).signIn("code", "verifier")
        assertTrue(jar.has(server.url("/"), ACCOUNT_COOKIE))

        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"not_signed_in"}"""))
        val accounts = accounts(jar)
        accounts.refresh()
        assertNull(accounts.me.value)
        assertFalse(jar.has(server.url("/"), ACCOUNT_COOKIE))
    }

    @Test
    fun `signing out ends the session on the server and forgets it here`() = runBlocking {
        server.enqueue(session)
        server.enqueue(MockResponse().setBody("""{"id":7,"nickname":"giuli"}"""))
        server.enqueue(MockResponse().setResponseCode(204))
        val jar = PersistentCookieJar(storage)
        val accounts = accounts(jar)
        accounts.signIn("code", "verifier")
        server.takeRequest(); server.takeRequest()

        accounts.signOut()

        val logout = server.takeRequest()
        assertEquals("POST /api/auth/logout", "${logout.method} ${logout.path}")
        assertEquals("ss_account=tok", logout.getHeader("Cookie"))
        assertNull(accounts.me.value)
        assertFalse(jar.has(server.url("/"), ACCOUNT_COOKIE))
    }
}

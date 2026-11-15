package lol.juntos.core.account

import kotlinx.coroutines.runBlocking
import lol.juntos.core.api.HttpJuntosApi
import lol.juntos.core.api.MemoryCookieStorage
import lol.juntos.core.api.PersistentCookieJar
import lol.juntos.core.api.juntosHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test

class AccountsTest {
    @get:Rule val server = MockWebServer()
    private val storage = MemoryCookieStorage()
    private fun accounts(jar: PersistentCookieJar = PersistentCookieJar(storage)): Accounts {
        val base = server.url("/").toString()
        return Accounts(HttpJuntosApi(base, juntosHttpClient(jar, "JuntosApp/test")), jar, base)
    }

    @Test
    fun `a session from the Discord login signs every later call in, across restarts`() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"id":7,"nickname":"giuli","avatar":"fox.bowtie","stats":{}}"""))
        val accounts = accounts()
        accounts.signIn("tok")

        assertEquals("giuli", accounts.me.value?.nickname)
        assertEquals("fox.bowtie", accounts.me.value?.avatar)
        assertEquals("ss_account=tok", server.takeRequest().getHeader("Cookie"))

        server.enqueue(MockResponse().setBody("""{"id":7,"nickname":"giuli"}"""))
        val reopened = accounts()
        reopened.refresh()
        assertEquals(7L, reopened.me.value?.id)
        assertEquals("ss_account=tok", server.takeRequest().getHeader("Cookie"))
    }

    @Test
    fun `a session the server no longer knows is dropped`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"not_signed_in"}"""))
        val jar = PersistentCookieJar(storage)
        val accounts = accounts(jar)
        accounts.signIn("velho")

        assertNull(accounts.me.value)
        assertFalse(jar.has(server.url("/"), ACCOUNT_COOKIE))
    }

    @Test
    fun `a server that fails keeps the session for the next try`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(503))
        val jar = PersistentCookieJar(storage)
        accounts(jar).signIn("tok")
        assert(jar.has(server.url("/"), ACCOUNT_COOKIE))
    }

    @Test
    fun `signing out ends the session on the server and forgets it here`() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"id":7,"nickname":"giuli"}"""))
        server.enqueue(MockResponse().setResponseCode(204))
        val jar = PersistentCookieJar(storage)
        val accounts = accounts(jar)
        accounts.signIn("tok")
        server.takeRequest()

        accounts.signOut()

        val logout = server.takeRequest()
        assertEquals("POST /api/auth/logout", "${logout.method} ${logout.path}")
        assertEquals("ss_account=tok", logout.getHeader("Cookie"))
        assertNull(accounts.me.value)
        assertFalse(jar.has(server.url("/"), ACCOUNT_COOKIE))
    }

    @Test
    fun `the session is read out of the WebView's cookie header`() {
        assertEquals("abc", sessionFrom("ss_human=1.sig; ss_account=abc; x=y"))
        assertNull(sessionFrom("ss_human=1.sig"))
        assertNull(sessionFrom(null))
        assertNull(sessionFrom("ss_account="))
    }
}

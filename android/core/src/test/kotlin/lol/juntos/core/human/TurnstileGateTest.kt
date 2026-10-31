package lol.juntos.core.human

import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import lol.juntos.core.api.JuntosApi
import lol.juntos.core.api.MemoryCookieStorage
import lol.juntos.core.api.PersistentCookieJar
import lol.juntos.core.fake.FakeJuntosApi
import lol.juntos.core.model.PublicConfig
import okhttp3.Cookie
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TurnstileGateTest {
    private val site = "https://juntos.lol".toHttpUrl()
    private val jar = PersistentCookieJar(MemoryCookieStorage())

    /** A server with Turnstile on, whose /api/human hands out the day's cookie. */
    private val api = object : JuntosApi by FakeJuntosApi() {
        override suspend fun config() = PublicConfig(turnstileSiteKey = "site-key")
        override suspend fun verifyHuman(token: String) {
            val day = Cookie.Builder().name(HUMAN_COOKIE).value(token).hostOnlyDomain("juntos.lol").path("/")
                .expiresAt(System.currentTimeMillis() + 86_400_000).build()
            jar.saveFromResponse(site, listOf(day))
        }
    }

    @Test
    fun `two checks at once show one widget and both pass on its answer`() = runBlocking {
        val shown = AtomicInteger()
        val answer = CompletableDeferred<String?>()
        val gate = TurnstileGate(api, jar, "https://juntos.lol") { shown.incrementAndGet(); answer.await() }
        val creating = async { gate.ensure() }
        val joining = async { gate.ensure() }
        repeat(3) { yield() }
        answer.complete("token")
        assertTrue(creating.await())
        assertTrue(joining.await())
        assertEquals(1, shown.get())
    }
}

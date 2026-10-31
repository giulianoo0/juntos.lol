package lol.juntos.core.human

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import lol.juntos.core.api.JuntosApi
import lol.juntos.core.api.PersistentCookieJar
import okhttp3.HttpUrl.Companion.toHttpUrl

const val HUMAN_COOKIE = "ss_human"

/**
 * Nothing to do while `ss_human` holds or the server runs without Turnstile; otherwise [solve]
 * runs the widget for the site key (a WebView in the app) and its token is spent on /api/human.
 */
class TurnstileGate(
    private val api: JuntosApi,
    private val cookies: PersistentCookieJar,
    baseUrl: String,
    private val solve: suspend (siteKey: String) -> String?,
) : HumanGate {
    private val site = baseUrl.toHttpUrl()

    // Creating a room and opening its socket both ask: the second waits for the first's widget.
    private val checking = Mutex()

    override suspend fun ensure(): Boolean = checking.withLock {
        if (cookies.has(site, HUMAN_COOKIE)) return@withLock true
        val siteKey = api.config().turnstileSiteKey
        if (siteKey.isNullOrEmpty()) return@withLock true
        val token = solve(siteKey) ?: return@withLock false
        api.verifyHuman(token)
        cookies.has(site, HUMAN_COOKIE)
    }

    override fun forget() = cookies.remove(site, HUMAN_COOKIE)
}

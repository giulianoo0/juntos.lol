package lol.juntos.core.account

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import lol.juntos.core.api.Account
import lol.juntos.core.api.JuntosApi
import lol.juntos.core.api.PersistentCookieJar
import okhttp3.Cookie
import okhttp3.HttpUrl.Companion.toHttpUrl

/** internal/httpapi/accounts.go accountCookie. */
const val ACCOUNT_COOKIE = "ss_account"

private const val SESSION_MS = 30L * 24 * 60 * 60 * 1000

/**
 * Who this phone is signed in as. The session is the site's `ss_account` cookie, kept in
 * the jar the API, the socket and the media share, so every call goes as the account.
 */
class Accounts(
    private val api: JuntosApi,
    private val cookies: PersistentCookieJar,
    baseUrl: String,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val base = baseUrl.toHttpUrl()
    private val signed = MutableStateFlow<Account?>(null)
    val me: StateFlow<Account?> = signed.asStateFlow()

    /** Asks the server who the kept session is; one it no longer knows is dropped. A failed call keeps it. */
    suspend fun refresh() {
        if (!cookies.has(base, ACCOUNT_COOKIE)) {
            signed.value = null
            return
        }
        val account = runCatching { api.me() }.getOrElse { return }
        if (account == null) cookies.remove(base, ACCOUNT_COOKIE)
        signed.value = account
    }

    /** Keeps the session the Discord login left on the site and learns who it is. */
    suspend fun signIn(session: String) {
        val cookie = Cookie.Builder()
            .name(ACCOUNT_COOKIE)
            .value(session)
            .hostOnlyDomain(base.host)
            .path("/")
            .expiresAt(now() + SESSION_MS)
            .httpOnly()
            .apply { if (base.isHttps) secure() }
            .build()
        cookies.saveFromResponse(base, listOf(cookie))
        refresh()
    }

    suspend fun signOut() {
        if (cookies.has(base, ACCOUNT_COOKIE)) runCatching { api.logout() }
        cookies.remove(base, ACCOUNT_COOKIE)
        signed.value = null
    }
}

/** The `ss_account` value in a `Cookie` header as WebView's CookieManager gives it, or null. */
fun sessionFrom(cookieHeader: String?): String? = cookieHeader
    ?.split(';')
    ?.map { it.trim() }
    ?.firstOrNull { it.startsWith("$ACCOUNT_COOKIE=") }
    ?.substringAfter('=')
    ?.takeIf { it.isNotEmpty() }

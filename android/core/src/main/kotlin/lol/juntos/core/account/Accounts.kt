package lol.juntos.core.account

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import lol.juntos.core.api.Account
import lol.juntos.core.api.JuntosApi
import lol.juntos.core.api.PersistentCookieJar
import okhttp3.HttpUrl.Companion.toHttpUrl

/** internal/httpapi/accounts.go accountCookie. */
const val ACCOUNT_COOKIE = "ss_account"

/**
 * Who this phone is signed in as. The session is the site's `ss_account` cookie, kept in
 * the jar the API, the socket and the media share, so every call goes as the account.
 */
class Accounts(
    private val api: JuntosApi,
    private val cookies: PersistentCookieJar,
    baseUrl: String,
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

    /**
     * Where the browser starts the sign-in: the site sends it through Discord when needed
     * and comes back with a code worth something only next to [verifier].
     */
    fun startUrl(verifier: String): String =
        base.newBuilder().addPathSegments("api/auth/app").addQueryParameter("challenge", challengeOf(verifier)).build().toString()

    /** Trades the code the browser brought back for this phone's own session. */
    suspend fun signIn(code: String, verifier: String): Boolean {
        runCatching { api.redeemAppLogin(code, verifier) }.getOrElse { return false }
        refresh()
        return signed.value != null
    }

    suspend fun signOut() {
        if (cookies.has(base, ACCOUNT_COOKIE)) runCatching { api.logout() }
        cookies.remove(base, ACCOUNT_COOKIE)
        signed.value = null
    }
}

/** A fresh secret for one sign-in: 32 random bytes, base64url. */
fun newVerifier(random: java.security.SecureRandom = java.security.SecureRandom()): String =
    java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32).also(random::nextBytes))

/** What the site keeps of [verifier]: its SHA-256, base64url, as internal/httpapi/app_login.go checks it. */
fun challengeOf(verifier: String): String =
    java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(java.security.MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()))

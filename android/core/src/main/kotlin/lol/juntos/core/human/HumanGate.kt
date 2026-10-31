package lol.juntos.core.human

/**
 * Turnstile in front of creating and entering rooms. The app solves it in a
 * WebView whose base URL is the site's, then hands the token to
 * [lol.juntos.core.api.JuntosApi.verifyHuman]. True once the cookie is fresh.
 */
fun interface HumanGate {
    suspend fun ensure(): Boolean
}

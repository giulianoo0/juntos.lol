package lol.juntos.app

import android.net.Uri

/** The room an intent opens: https://juntos.lol/room/{id} or juntos://room/{id}. */
fun roomIdFrom(uri: Uri?): String? {
    if (uri == null) return null
    val id = when (uri.scheme) {
        "https", "http" -> uri.pathSegments.takeIf { it.size >= 2 && it[0] == "room" }?.get(1)
        "juntos" -> uri.pathSegments.firstOrNull()?.takeIf { uri.host == "room" }
        else -> null
    }
    return id?.takeIf { it.matches(Regex("[A-Za-z0-9]{4,32}")) }
}

/** The sign-in code the browser hands back: https://juntos.lol/api/auth/app/done?code= or juntos://signed-in?code=. */
fun appLoginCodeFrom(uri: Uri?, host: String): String? {
    if (uri == null) return null
    val ours = when (uri.scheme) {
        "https" -> uri.host == host && uri.path == "/api/auth/app/done"
        "juntos" -> uri.host == "signed-in"
        else -> false
    }
    return uri.getQueryParameter("code")?.takeIf { ours && it.matches(Regex("[A-Za-z0-9_-]{16,64}")) }
}

/** The pref that keeps a sign-in's verifier while the browser is out with Discord. */
const val LOGIN_VERIFIER = "login.verifier"

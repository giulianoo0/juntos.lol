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

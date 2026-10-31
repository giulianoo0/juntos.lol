package lol.juntos.app.room

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder

private const val MAX_TRACKERS = 20
private val PRIVATE_SUFFIX = Regex("\\.(local|lan|home|internal|intranet|corp|localhost|test|invalid|arpa)$")
private val TRACKER_SCHEMES = setOf("udp", "http", "https", "wss")

/**
 * The magnet the room keeps for other apps, as the site's safeLocalCopy writes it: the hash
 * spelled out, the name, and trackers on public names. A pasted `urn%3Abtih%3A` opens here
 * but the server only takes the plain form; addresses and web seeds never leave this phone.
 */
fun roomMagnet(infohash: String, pasted: String): String {
    val params = pasted.trim().substringAfter("magnet:?", "").split('&').mapNotNull { pair ->
        val key = pair.substringBefore('=', "").lowercase()
        val value = runCatching { URLDecoder.decode(pair.substringAfter('=', ""), "UTF-8") }.getOrNull()
        if (key.isEmpty() || value == null) null else key to value
    }
    val parts = mutableListOf("xt=urn:btih:${infohash.lowercase()}")
    params.firstOrNull { it.first == "dn" }?.second?.takeIf { it.isNotBlank() }?.let { parts += "dn=${encode(it.take(200))}" }
    params.filter { it.first == "tr" && publicTracker(it.second) }.map { it.second }.distinct().take(MAX_TRACKERS).forEach { parts += "tr=${encode(it)}" }
    return "magnet:?" + parts.joinToString("&")
}

private fun encode(value: String) = URLEncoder.encode(value, "UTF-8").replace("+", "%20")

private fun publicTracker(raw: String): Boolean {
    val uri = runCatching { URI(raw) }.getOrNull() ?: return false
    if (uri.scheme?.lowercase() !in TRACKER_SCHEMES) return false
    val host = uri.host?.lowercase() ?: return false
    if ('.' !in host || host.startsWith('[') || ':' in host) return false
    if (host.all { it.isDigit() || it == '.' } || host.startsWith("0x")) return false
    return !PRIVATE_SUFFIX.containsMatchIn(host)
}

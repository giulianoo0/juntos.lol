package lol.juntos.app.room

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder

private const val MAX_TRACKERS = 20
private val PRIVATE_SUFFIX = Regex("\\.(local|lan|home|internal|intranet|corp|localhost|test|invalid|arpa)$")
private val TRACKER_SCHEMES = setOf("udp", "http", "https", "wss")

data class ParsedMagnet(val infoHash: String, val trackers: List<String>, val dn: String)

private val BTIH = Regex("^urn:btih:([0-9a-fA-F]{40}|[A-Za-z2-7]{32})$")

/** The hash in hex, the trackers and the name; null without a usable hash. Encoded values are read decoded. */
fun parseMagnet(magnet: String): ParsedMagnet? {
    val trimmed = magnet.trim()
    if (!trimmed.lowercase().startsWith("magnet:?")) return null
    val params = trimmed.substring("magnet:?".length).split('&').mapNotNull { pair ->
        val key = pair.substringBefore('=', "").lowercase()
        val value = runCatching { URLDecoder.decode(pair.substringAfter('=', ""), "UTF-8") }.getOrNull()
        if (key.isEmpty() || value == null) null else key to value
    }
    val hash = params.filter { it.first == "xt" }.firstNotNullOfOrNull { (_, xt) ->
        BTIH.find(xt)?.groupValues?.get(1)?.let { if (it.length == 40) it.lowercase() else base32ToHex(it) }
    } ?: return null
    return ParsedMagnet(hash, params.filter { it.first == "tr" }.map { it.second }.take(MAX_TRACKERS), params.firstOrNull { it.first == "dn" }?.second.orEmpty())
}

private fun base32ToHex(value: String): String? {
    val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
    val bits = value.uppercase().map { alphabet.indexOf(it) }.takeIf { it.none { i -> i < 0 } }
        ?.joinToString("") { it.toString(2).padStart(5, '0') } ?: return null
    val hex = bits.chunked(8).filter { it.length == 8 }.joinToString("") { it.toInt(2).toString(16).padStart(2, '0') }
    return hex.takeIf { it.length == 40 }
}

/** The trackers worth handing on: public names only, as the room and the fleet take them. */
fun publicTrackers(trackers: List<String>): List<String> = trackers.filter(::publicTracker).distinct().take(MAX_TRACKERS)

/**
 * The magnet the room keeps for other apps, as the site's safeLocalCopy writes it: the hash
 * spelled out, the name, and trackers on public names. A pasted `urn%3Abtih%3A` opens here
 * but the server only takes the plain form; addresses and web seeds never leave this phone.
 */
fun roomMagnet(infohash: String, pasted: String): String {
    val parsed = parseMagnet(pasted)
    val parts = mutableListOf("xt=urn:btih:${infohash.lowercase()}")
    parsed?.dn?.takeIf { it.isNotBlank() }?.let { parts += "dn=${encode(it.take(200))}" }
    publicTrackers(parsed?.trackers.orEmpty()).forEach { parts += "tr=${encode(it)}" }
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

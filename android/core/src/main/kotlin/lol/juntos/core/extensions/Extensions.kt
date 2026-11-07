package lol.juntos.core.extensions

import java.net.URI
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

// Protocol v1 as the site speaks it (web/src/extensions/protocol.ts and registry.ts):
// what an extension may say, checked here before the room acts on any of it.

const val ANY_HOST = "*"
private val ID = Regex("^[a-z][a-z0-9-]{2,31}$")
private val SUB = Regex("^[a-z2-7]{16}$")
private val SHA = Regex("^[0-9a-f]{40}$")
private val SEGMENT = Regex("^[A-Za-z0-9_-][A-Za-z0-9._@+-]{0,127}$")
private val LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
private val HOST = Regex("^(?:$LABEL\\.)+[a-z][a-z0-9-]*[a-z0-9]$")
private val RESERVED = listOf("juntos.lol", "santamagia.com")
private val INFO_HASH = Regex("^[0-9a-fA-F]{40}$")
private val YOUTUBE_ID = Regex("^[A-Za-z0-9_-]{11}$")
private val LANG = Regex("^[A-Za-z0-9-]{2,16}$")
private val HEADER_NAMES = listOf("user-agent", "referer", "origin")
private const val MAX_TEXT = 200
private const val MAX_REF = 128
private const val MAX_URL = 2048
private const val MAX_HOSTS = 16

data class Hosts(val connect: List<String>, val images: List<String>, val media: List<String>)

data class Manifest(val id: String, val name: String, val version: String, val entry: String, val icon: String?, val hosts: Hosts, val captcha: String? = null)

/** An id the server knows: where it runs and where its code lives. */
data class Registered(val id: String, val name: String, val sub: String, val repo: String)

/** One extension this phone approved, at a commit. */
data class Installed(val id: String, val sub: String, val version: String, val manifest: Manifest)

sealed interface ExtSource {
    data class Media(val hls: Boolean, val url: String, val headers: Map<String, String>) : ExtSource
    data class Torrent(val infoHash: String, val fileIdx: Int?, val trackers: List<String>) : ExtSource
    data class Youtube(val id: String) : ExtSource
}

data class ExtSubtitle(val url: String, val lang: String, val label: String?)

sealed interface ExtMessage {
    data object Ready : ExtMessage
    data object Close : ExtMessage
    data class Toast(val text: String) : ExtMessage
    data class Play(val title: String, val subtitle: String?, val ref: String, val source: ExtSource, val subtitles: List<ExtSubtitle>) : ExtMessage
    data class Refreshed(val nonce: String, val source: ExtSource?) : ExtMessage
}

fun validId(raw: String): Boolean = ID.matches(raw)

fun extensionOrigin(sub: String, base: String, scheme: String): String = "$scheme://$sub.$base"

fun frameUrl(extension: Installed, base: String, scheme: String): String =
    "${extensionOrigin(extension.sub, base, scheme)}/@${extension.version}/${extension.manifest.entry}"

private fun JsonElement?.str(max: Int = MAX_TEXT): String? =
    (this as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.length <= max }

private fun JsonElement?.obj(): JsonObject? = this as? JsonObject

fun parseRegistered(element: JsonElement): Registered? {
    val o = element.obj() ?: return null
    val id = o["id"].str() ?: return null
    val name = o["name"].str()?.takeIf { it.isNotEmpty() && it.codePointCount(0, it.length) <= 64 } ?: return null
    val sub = o["sub"].str()?.takeIf(SUB::matches) ?: return null
    val source = o["source"].str() ?: return null
    if (!ID.matches(id) || !Regex("^github:[A-Za-z0-9-]+/[A-Za-z0-9._-]+$").matches(source)) return null
    return Registered(id, name, sub, source.removePrefix("github:"))
}

fun validSha(raw: String): Boolean = SHA.matches(raw)

private fun relativePath(value: String?, exts: List<String>): Boolean =
    value != null && value.isNotEmpty() && value.length <= 256 && exts.any { value.endsWith(".$it") } &&
        value.split('/').all { SEGMENT.matches(it) && !it.contains("..") }

private fun validHost(entry: String, wildcard: Boolean): Boolean {
    val host = if (wildcard && entry.startsWith("*.")) entry.drop(2) else entry
    if (host.length > 253 || !HOST.matches(host) || host.endsWith(".localhost")) return false
    return RESERVED.none { host == it || host.endsWith(".$it") }
}

private val KEYS = listOf("id", "name", "version", "protocol", "entry", "icon", "hosts", "captcha")
private val HOST_KEYS = listOf("connect", "images", "media")

/** A known key written in another case is a mistake, not an unknown key. */
private fun sameKeys(o: JsonObject, known: List<String>) = o.keys.all { it in known || it.lowercase() !in known }

/** "" and null count as absent, as in Go. */
private fun given(value: JsonElement?) = value != null && value !is JsonNull && !(value is JsonPrimitive && value.isString && value.content.isEmpty())

private fun hostList(value: JsonElement?, wildcard: Boolean): List<String>? {
    if (value == null || value is JsonNull) return emptyList()
    val array = value as? JsonArray ?: return null
    if (array.size > MAX_HOSTS) return null
    val entries = array.map { it.str(253) ?: return null }
    if (entries == listOf(ANY_HOST)) return entries
    return entries.takeIf { list -> list.all { validHost(it, wildcard) } }
}

private fun runes(value: String) = value.codePointCount(0, value.length)

/** The same rules as the site's registry.ts and Go's, case by case in extensions/manifest-cases.json. */
fun parseManifest(element: JsonElement): Manifest? {
    val o = element.obj()?.takeIf { sameKeys(it, KEYS) } ?: return null
    val id = (o["id"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { ID.matches(it) && it != "host" } ?: return null
    val name = (o["name"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim()?.takeIf { it.isNotEmpty() && runes(it) <= 64 } ?: return null
    val version = (o["version"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() && runes(it) <= 64 } ?: return null
    val protocol = o["protocol"] as? JsonPrimitive
    if (protocol == null || protocol.isString || protocol.intOrNull != 1) return null
    val entry = o["entry"].str(256)?.takeIf { relativePath(it, listOf("html")) } ?: return null
    val icon = if (given(o["icon"])) o["icon"].str(256)?.takeIf { relativePath(it, listOf("png", "svg")) } ?: return null else null
    val captcha = if (given(o["captcha"])) o["captcha"].str()?.takeIf { it == "hcaptcha" } ?: return null else null
    val hosts = when (val raw = o["hosts"]) {
        null, is JsonNull -> JsonObject(emptyMap())
        else -> raw.obj()?.takeIf { sameKeys(it, HOST_KEYS) } ?: return null
    }
    val connect = hostList(hosts["connect"], false) ?: return null
    val images = hostList(hosts["images"], false) ?: return null
    val media = hostList(hosts["media"], true) ?: return null
    return Manifest(id, name, version, entry, icon, Hosts(connect, images, media), captcha)
}

/** Whether `host` is one of `allowed`; `*.domain` takes any subdomain, `*` any host. */
fun hostAllowed(host: String, allowed: List<String>): Boolean = allowed.any { entry ->
    if (entry == ANY_HOST || entry.startsWith("*.")) host.endsWith(entry.drop(1)) && host.length > entry.length - 1 else host == entry
}

/** A host written as this phone or its network. */
private fun localHost(host: String): Boolean {
    if (host == "localhost" || host.endsWith(".localhost") || host.startsWith("[")) return true
    val ip = Regex("^(\\d+)\\.(\\d+)\\.(\\d+)\\.(\\d+)$").find(host) ?: return false
    val a = ip.groupValues[1].toInt()
    val b = ip.groupValues[2].toInt()
    return a == 0 || a == 10 || a == 127 || (a == 169 && b == 254) || (a == 172 && b in 16..31) || (a == 192 && b == 168) || (a == 100 && b in 64..127)
}

/** http or https, no credentials, on one of the manifest's media hosts and off this phone's network. */
fun mediaUrlAllowed(raw: String, allowed: List<String>, https: Boolean = false): Boolean {
    val url = runCatching { URI(raw) }.getOrNull() ?: return false
    val scheme = url.scheme?.lowercase() ?: return false
    if (scheme != "https" && (https || scheme != "http")) return false
    if (url.rawUserInfo != null) return false
    if (https && url.port != -1) return false
    val host = url.host?.lowercase() ?: return false
    return !localHost(host) && hostAllowed(host, allowed)
}

private fun headers(value: JsonElement?): Map<String, String>? {
    if (value == null) return emptyMap()
    val o = value.obj() ?: return null
    val out = mutableMapOf<String, String>()
    for ((key, raw) in o) {
        val name = key.lowercase()
        if (name !in HEADER_NAMES || name in out) return null
        val said = raw.str(512) ?: return null
        if (said.any { it == '\r' || it == '\n' || it == '\u0000' }) return null
        out[name] = said
    }
    return out
}

private fun source(value: JsonElement?, manifest: Manifest): ExtSource? {
    val o = value.obj() ?: return null
    return when (o["kind"].str()) {
        "hls", "file" -> {
            val url = o["url"].str(MAX_URL)?.takeIf { mediaUrlAllowed(it, manifest.hosts.media) } ?: return null
            ExtSource.Media(o["kind"].str() == "hls", url, headers(o["headers"]) ?: return null)
        }
        "torrent" -> {
            val hash = o["infoHash"].str()?.takeIf(INFO_HASH::matches) ?: return null
            val index = o["fileIdx"]?.let { (it as? JsonPrimitive)?.intOrNull?.takeIf { i -> i in 0..9999 } ?: return null }
            val trackers = (o["trackers"] as? JsonArray)?.mapNotNull { t ->
                t.str(300)?.takeIf { raw -> runCatching { URI(raw) }.getOrNull()?.let { it.scheme in listOf("udp", "http", "https") && it.host != null && !localHost(it.host) } == true }
            }?.take(20) ?: emptyList()
            ExtSource.Torrent(hash.lowercase(), index, trackers)
        }
        "youtube" -> o["id"].str()?.takeIf(YOUTUBE_ID::matches)?.let(ExtSource::Youtube)
        else -> null
    }
}

private fun subtitles(value: JsonElement?, manifest: Manifest): List<ExtSubtitle>? {
    if (value == null) return emptyList()
    val array = value as? JsonArray ?: return null
    if (array.size > 16) return null
    return array.map { entry ->
        val o = entry.obj() ?: return null
        val url = o["url"].str(MAX_URL)?.takeIf { mediaUrlAllowed(it, manifest.hosts.media, https = true) } ?: return null
        val lang = o["lang"].str(16)?.takeIf(LANG::matches) ?: return null
        ExtSubtitle(url, lang, o["label"]?.let { it.str(64) ?: return null })
    }
}

/** A message from the extension, or null when it does not pass the protocol. */
fun parseMessage(element: JsonElement, manifest: Manifest): ExtMessage? {
    val o = element.obj() ?: return null
    if ((o["juntos"] as? JsonPrimitive)?.intOrNull != 1) return null
    return when (o["type"].str()) {
        "ready" -> ExtMessage.Ready
        "close" -> ExtMessage.Close
        "toast" -> o["text"].str()?.let(ExtMessage::Toast)
        "refreshed" -> {
            val nonce = o["nonce"].str(MAX_REF) ?: return null
            val sent = o["source"]
            ExtMessage.Refreshed(nonce, if (sent == null || sent is JsonNull) null else source(sent, manifest) ?: return null)
        }
        "play" -> {
            val title = o["title"].str()?.takeIf { it.isNotBlank() } ?: return null
            val subtitle = o["subtitle"]?.let { it.str() ?: return null }
            val ref = o["ref"].str(MAX_REF)?.takeIf { it.isNotEmpty() } ?: return null
            ExtMessage.Play(title, subtitle, ref, source(o["source"], manifest) ?: return null, subtitles(o["subtitles"], manifest) ?: return null)
        }
        else -> null
    }
}

/** What the page sends when the extension says it is ready. */
fun initMessage(dark: Boolean, vars: Map<String, String>, locale: String, canPlay: Boolean): JsonObject = buildJsonObject {
    put("juntos", 1)
    put("type", "init")
    put("theme", buildJsonObject {
        put("mode", if (dark) "dark" else "light")
        put("vars", JsonObject(vars.mapValues { JsonPrimitive(it.value) }))
    })
    put("locale", locale)
    put("canPlay", canPlay)
    // The phone reads any address itself: what only the desktop app plays, plays here.
    put("app", true)
}

/** The magnet a torrent source stands for. */
fun torrentMagnet(source: ExtSource.Torrent, name: String?): String {
    val enc = { s: String -> java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20") }
    val params = mutableListOf("xt=urn:btih:${source.infoHash}")
    if (!name.isNullOrBlank()) params += "dn=${enc(name)}"
    source.trackers.forEach { params += "tr=${enc(it)}" }
    return "magnet:?${params.joinToString("&")}"
}

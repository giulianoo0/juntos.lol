package lol.juntos.core.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import lol.juntos.core.JuntosJson
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl

/** Where the jar keeps its lasting cookies between runs; the app backs it with its preferences. */
interface CookieStorage {
    fun read(): String?
    fun write(value: String)
}

class MemoryCookieStorage : CookieStorage {
    private var value: String? = null
    override fun read() = value
    override fun write(value: String) { this.value = value }
}

/** The cookie jar of [juntosHttpClient]: `ss_human` outlives the process, so the day's check is done once. */
class PersistentCookieJar(
    private val storage: CookieStorage,
    private val now: () -> Long = System::currentTimeMillis,
) : CookieJar {
    private val cookies = storage.read()
        ?.let { runCatching { JuntosJson.decodeFromString<List<StoredCookie>>(it) }.getOrNull() }
        .orEmpty()
        .map(StoredCookie::cookie)
        .toMutableList()

    @Synchronized
    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        for (cookie in cookies) {
            this.cookies.removeAll { it.name == cookie.name && it.domain == cookie.domain && it.path == cookie.path }
            if (cookie.expiresAt > now()) this.cookies += cookie
        }
        persist()
    }

    @Synchronized
    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        if (cookies.removeAll { it.expiresAt <= now() }) persist()
        return cookies.filter { it.matches(url) }
    }

    @Synchronized
    fun has(url: HttpUrl, name: String) = loadForRequest(url).any { it.name == name }

    @Synchronized
    fun remove(url: HttpUrl, name: String) {
        if (cookies.removeAll { it.name == name && it.matches(url) }) persist()
    }

    private fun persist() {
        storage.write(JuntosJson.encodeToString(cookies.filter { it.persistent }.map(::StoredCookie)))
    }

    @Serializable
    private class StoredCookie(
        val name: String,
        val value: String,
        val expiresAt: Long,
        val domain: String,
        val path: String,
        val secure: Boolean,
        val httpOnly: Boolean,
        val hostOnly: Boolean,
    ) {
        constructor(cookie: Cookie) : this(
            cookie.name, cookie.value, cookie.expiresAt, cookie.domain, cookie.path,
            cookie.secure, cookie.httpOnly, cookie.hostOnly,
        )

        fun cookie(): Cookie = Cookie.Builder()
            .name(name)
            .value(value)
            .expiresAt(expiresAt)
            .path(path)
            .apply {
                if (hostOnly) hostOnlyDomain(domain) else domain(domain)
                if (secure) secure()
                if (httpOnly) httpOnly()
            }
            .build()
    }
}

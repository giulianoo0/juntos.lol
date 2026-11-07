package lol.juntos.app.extensions

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import lol.juntos.app.entry.Prefs
import lol.juntos.core.JuntosJson
import lol.juntos.core.api.ApiException
import lol.juntos.core.api.JuntosApi
import lol.juntos.core.extensions.Installed
import lol.juntos.core.extensions.parseManifest
import lol.juntos.core.extensions.parseRegistered
import lol.juntos.core.extensions.validId
import lol.juntos.core.extensions.validSha
import lol.juntos.core.model.PublicConfig

/** Where extensions run and their code is read: the server says, juntos.lol's by default. */
data class Place(val base: String, val scheme: String, val raw: String, val defaults: List<String> = emptyList())

/** What a newer commit of an installed extension needs: nothing, or the person's eyes on new hosts. */
sealed interface Fresh {
    data class Ready(val extension: Installed) : Fresh
    data class Approve(val extension: Pair<Installed, JsonElement>) : Fresh
}

class ExtensionError(val code: String) : Exception(code)

/**
 * The extensions this phone approved, as the site's installed.ts keeps them: the server's
 * defaults come installed, and any other update that asks for new hosts waits for the person.
 */
class ExtensionShelf(private val api: JuntosApi, private val prefs: Prefs) {
    private var place: Place? = null

    suspend fun place(): Place = place ?: runCatching { api.config() }.getOrElse { PublicConfig() }
        .let { config -> Place(config.extensionBase, config.extensionScheme, config.extensionRaw.trimEnd('/'), config.extensionDefaults.filter(::validId)) }
        .also { place = it }

    private fun readAll(): Map<String, Pair<Installed, JsonElement>> {
        val raw = prefs.get(KEY) ?: return emptyMap()
        val all = runCatching { JuntosJson.parseToJsonElement(raw).jsonObject }.getOrNull() ?: return emptyMap()
        return all.mapNotNull { (id, entry) ->
            val o = entry as? JsonObject ?: return@mapNotNull null
            val manifestJson = o["manifest"] ?: return@mapNotNull null
            val manifest = parseManifest(manifestJson)?.takeIf { it.id == id } ?: return@mapNotNull null
            val sub = (o["sub"] as? JsonPrimitive)?.content ?: return@mapNotNull null
            val version = (o["version"] as? JsonPrimitive)?.content ?: return@mapNotNull null
            id to (Installed(id, sub, version, manifest) to manifestJson)
        }.toMap()
    }

    private fun writeAll(all: Map<String, Pair<Installed, JsonElement>>) {
        val json = JsonObject(all.mapValues { (_, value) ->
            buildJsonObject {
                put("sub", value.first.sub)
                put("version", value.first.version)
                put("manifest", value.second)
            }
        })
        prefs.put(KEY, json.toString())
    }

    fun installed(): List<Installed> = readAll().values.map { it.first }.sortedBy { it.manifest.name.lowercase() }

    /** The newest commit of a registered id and its manifest, not installed yet. */
    suspend fun latest(raw: String): Pair<Installed, JsonElement> {
        val id = raw.trim().lowercase()
        if (!validId(id)) throw ExtensionError("bad_id")
        val registered = try {
            parseRegistered(api.extension(id))?.takeIf { it.id == id } ?: throw ExtensionError("failed")
        } catch (e: ApiException) {
            throw ExtensionError(if (e.status == 404) "not_found" else "failed")
        }
        val sha = api.extensionSha(id).takeIf(::validSha) ?: throw ExtensionError("failed")
        val manifestJson = api.fetchJson("${place().raw}/${registered.repo}/$sha/juntos.json")
        val manifest = parseManifest(manifestJson)?.takeIf { it.id == id } ?: throw ExtensionError("bad_manifest")
        return Installed(id, registered.sub, sha, manifest) to manifestJson
    }

    fun install(extension: Pair<Installed, JsonElement>) {
        writeAll(readAll() + (extension.first.id to extension))
    }

    fun forget(id: String) {
        writeAll(readAll() - id)
    }

    /** The server's defaults: installed when missing and brought to the newest commit, without asking. */
    suspend fun ensureDefaults() {
        for (id in place().defaults) {
            val newest = runCatching { latest(id) }.getOrNull() ?: continue
            if (readAll()[id]?.first?.version != newest.first.version) install(newest)
        }
    }

    /** Before opening: a newer commit that reaches the same hosts (or of a default) goes in on its own. */
    suspend fun fresh(extension: Installed): Fresh {
        val newest = runCatching { latest(extension.id) }.getOrNull() ?: return Fresh.Ready(extension)
        if (newest.first.version == extension.version) return Fresh.Ready(extension)
        val old = extension.manifest.hosts
        val new = newest.first.manifest.hosts
        val same = new.media.all { it in old.media } && new.connect.all { it in old.connect } && new.images.all { it in old.images }
        if (!same && extension.id !in place().defaults) return Fresh.Approve(newest)
        install(newest)
        return Fresh.Ready(newest.first)
    }

    private companion object {
        const val KEY = "ss.extensions"
    }
}

/** The words for an [ExtensionError] code. */
fun extensionErrorText(code: String?): String = when (code) {
    "bad_id" -> "Esse ID não vale"
    "not_found" -> "Nenhuma extensão com esse ID"
    "bad_manifest" -> "O juntos.json desse repositório não vale"
    else -> "Não deu certo. Tente de novo"
}

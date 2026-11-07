package lol.juntos.core.extensions

import java.io.File
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import lol.juntos.core.JuntosJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/** The one table of what a juntos.json may be: Go, the extension host and the site read it too. */
class ManifestCasesTest {
    private val table = JuntosJson.parseToJsonElement(File("../../extensions/manifest-cases.json").readText()).jsonObject
    private val base = table["base"]!!.jsonObject

    private fun withCase(case: JsonObject): JsonElement {
        case["replace"]?.let { return it }
        val set = case["set"]?.jsonObject ?: JsonObject(emptyMap())
        val unset = case["unset"]?.jsonArray?.map { it.jsonPrimitive.content }.orEmpty()
        return JsonObject((base + set) - unset.toSet())
    }

    private fun field(manifest: Manifest, key: String): JsonElement = when (key) {
        "name" -> JsonPrimitive(manifest.name)
        "icon" -> manifest.icon?.let(::JsonPrimitive) ?: JsonNull
        "captcha" -> manifest.captcha?.let(::JsonPrimitive) ?: JsonNull
        "version" -> JsonPrimitive(manifest.version)
        "entry" -> JsonPrimitive(manifest.entry)
        "hosts" -> JsonObject(
            mapOf(
                "connect" to JsonArray(manifest.hosts.connect.map(::JsonPrimitive)),
                "images" to JsonArray(manifest.hosts.images.map(::JsonPrimitive)),
                "media" to JsonArray(manifest.hosts.media.map(::JsonPrimitive)),
            ),
        )
        else -> error("no field $key")
    }

    @Test
    fun `accepts every manifest the table accepts, as it normalizes them`() {
        for (entry in table["accept"]!!.jsonArray) {
            val case = entry.jsonObject
            val name = case["case"]!!.jsonPrimitive.content
            val manifest = parseManifest(withCase(case))
            assertNotNull(name, manifest)
            for ((key, want) in case["expect"]?.jsonObject.orEmpty()) assertEquals("$name: $key", want, field(manifest!!, key))
        }
    }

    @Test
    fun `refuses every manifest the table refuses`() {
        for (entry in table["refuse"]!!.jsonArray) {
            val case = entry.jsonObject
            assertNull(case["case"]!!.jsonPrimitive.content, parseManifest(withCase(case)))
        }
    }
}

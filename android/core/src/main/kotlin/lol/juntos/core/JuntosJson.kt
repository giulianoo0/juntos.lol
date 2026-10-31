package lol.juntos.core

import kotlinx.serialization.json.Json

val JuntosJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = false
}

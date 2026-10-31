package lol.juntos.app.room

import java.util.Locale
import kotlin.math.ceil
import lol.juntos.core.media.regionHolds
import lol.juntos.core.model.MediaRegion
import lol.juntos.core.model.RoomInfo
import lol.juntos.core.model.RoomPreparation
import lol.juntos.player.languageLabel

enum class StageStatus { Empty, Preparing, Ready, Failed }

/**
 * What the video stage shows, as web/src/desktop/localView.ts reads it: the host playing its
 * own cache is ready once a region has frames; anyone else waits for the bucket.
 */
fun stageStatus(room: RoomInfo?, hostRegions: List<MediaRegion>?): StageStatus {
    if (hostRegions != null) return if (hostRegions.any { it.producedMs > 0 }) StageStatus.Ready else StageStatus.Preparing
    return when (room?.status.orEmpty()) {
        "", "empty" -> StageStatus.Empty
        "ready" -> StageStatus.Ready
        "error" -> StageStatus.Failed
        else -> StageStatus.Preparing
    }
}

/** The bar's length: the room's, else the host's own probe; 0 lets the player say. */
fun timelineMs(room: RoomInfo?, hostDurationMs: Long?): Long =
    room?.durationMs?.takeIf { it > 0 } ?: hostDurationMs?.takeIf { it > 0 } ?: 0L

private const val GATE_MS = 10_000L
private const val SLOW_BUFFER_MS = 3_000L

/**
 * The pill over the stage while it waits, as the site's WaitLabel: a place no region holds is
 * being prepared; one that is held but slow says how much buffer is left to load.
 */
fun waitText(positionMs: Long, regions: List<MediaRegion>, bufferingForMs: Long, bufferAheadMs: Long): String? {
    if (regions.isNotEmpty() && regions.none { regionHolds(it, positionMs) }) return "Preparando essa parte do vídeo…"
    if (bufferingForMs < SLOW_BUFFER_MS) return null
    val left = ceil((GATE_MS - bufferAheadMs).coerceAtLeast(0) / 1000.0).toInt().coerceAtLeast(1)
    return "Carregando ${left}s de buffer"
}

fun preparationLine(prep: RoomPreparation?): String? = when (prep?.previewPhase) {
    "receiving" -> "Recebendo o vídeo de quem abriu a sala…"
    "probing" -> "Analisando o que já chegou…"
    "segmenting" -> "Montando o primeiro trecho…"
    "unavailable" -> "Este arquivo não permite prévia: a reprodução começa quando o download terminar."
    else -> null
}

/** How far the preview got, 0..1, or null while nothing says. */
fun preparationProgress(prep: RoomPreparation?): Float? {
    val received = prep?.receivedBytes ?: return null
    val target = (if (prep.previewPhase == "unavailable") prep.sourceBytes else prep.previewTargetBytes) ?: return null
    if (target <= 0) return null
    return (received.toFloat() / target).coerceIn(0f, 1f)
}

private val PROVIDER = Regex("^[A-Za-z]{2,4}_")
private val PARENS = Regex("\\(([^)]*)\\)")
private val REGIONS = mapOf(
    "brazil" to "Brasil", "brasil" to "Brasil", "portugal" to "Portugal", "european" to "Europa",
    "latin america" to "América Latina", "spain" to "Espanha", "castilian" to "Espanha",
    "simplified" to "Simplificado", "traditional" to "Tradicional", "hong kong" to "Hong Kong",
    "cc" to "CC", "auto-generated" to "automática", "sdh" to "SDH", "forced" to "Forçada", "signs" to "Placas",
)

/**
 * A subtitle's name as people read it: "NF_Portuguese(Brazil)" is "Português (Brasil)",
 * YouTube's "Portuguese" is "Português"; a title that names something else stays.
 */
fun subtitleLabel(title: String, language: String): String {
    val cleaned = title.trim().replace(PROVIDER, "").replace('_', ' ').trim()
    val extras = PARENS.findAll(cleaned).map { it.groupValues[1].trim() }.filter { it.isNotEmpty() }.toList()
    val base = cleaned.replace(PARENS, "").trim()
    val english = Locale.forLanguageTag(language).getDisplayLanguage(Locale.ENGLISH)
    val named = languageLabel(language)
    val plain = base.isEmpty() || base.equals(english, ignoreCase = true) || (named != null && base.equals(named, ignoreCase = true))
    if (!plain) return cleaned.ifEmpty { title }
    val name = named ?: base.ifEmpty { language }
    if (extras.isEmpty()) return name
    return "$name (${extras.joinToString(", ") { REGIONS[it.lowercase()] ?: it }})"
}

private fun isPortuguese(language: String) = language.lowercase().let { it == "por" || it == "pt" || it.startsWith("pt-") }
private fun isBrazilian(language: String, title: String) =
    language.lowercase() == "pt-br" || title.contains("bra", ignoreCase = true)

/** Where a subtitle goes in the list: Brazilian Portuguese, then Portuguese, then the rest as they came. */
fun subtitleRank(language: String, title: String): Int = when {
    isPortuguese(language) && isBrazilian(language, title) -> 0
    isPortuguese(language) -> 1
    else -> 2
}


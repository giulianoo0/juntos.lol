package lol.juntos.app.room

import kotlin.math.ceil
import kotlin.math.roundToInt
import lol.juntos.core.media.regionHolds
import lol.juntos.core.model.MediaRegion
import lol.juntos.core.model.RoomInfo
import lol.juntos.core.model.RoomPreparation
import lol.juntos.core.model.SwarmStats
import lol.juntos.player.englishLanguageName
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

/** The bytes the wait ends at, and whether that is when it plays rather than when the whole file is in. */
data class PrepTarget(val bytes: Long, val untilPlayable: Boolean)

/**
 * A file with no preview waits for all of it. Otherwise the wait ends when it can play: the
 * preview's target, else the first seconds at the file's bitrate, never the whole download.
 */
fun prepTarget(prep: RoomPreparation?, durationMs: Long = 0): PrepTarget {
    val source = prep?.sourceBytes ?: 0
    if (prep?.previewPhase == "unavailable") return PrepTarget(source, untilPlayable = false)
    val preview = prep?.previewTargetBytes ?: 0
    if (preview > 0) return PrepTarget(preview, untilPlayable = true)
    if (source > 0 && durationMs > 0) return PrepTarget(firstPlayBytes(source, durationMs), untilPlayable = true)
    return PrepTarget(0, untilPlayable = true)
}

private const val MIN_USEFUL_BYTES_PER_SECOND = 16 * 1024

/** Seconds left at [bytesPerSecond], or null while the rate is too thin to say. */
fun etaSeconds(receivedBytes: Long, targetBytes: Long, bytesPerSecond: Double): Double? {
    val remaining = targetBytes - receivedBytes
    if (remaining <= 0 || bytesPerSecond < MIN_USEFUL_BYTES_PER_SECOND) return null
    return remaining / bytesPerSecond
}

/** "menos de 1 min", "~4 min", "~2 h"; "quase lá" once everything it waits for is in. */
fun etaLabel(seconds: Double?, arrived: Boolean): String? = when {
    seconds == null -> if (arrived) "quase lá" else null
    seconds < 60 -> "menos de 1 min"
    seconds < 3600 -> "~${(seconds / 60).roundToInt()} min"
    else -> "~${(seconds / 3600).roundToInt()} h"
}

private val PT_BR = java.util.Locale.forLanguageTag("pt-BR")

fun megabytesPerSecond(bytesPerSecond: Long): String = String.format(PT_BR, "%.1f MB/s", bytesPerSecond / 1_048_576.0)

/** MB under a gigabyte, where "0,01 GB" would say nothing. */
fun byteSize(bytes: Long): String =
    if (bytes < 1_073_741_824) String.format(PT_BR, "%.0f MB", bytes / 1_048_576.0) else String.format(PT_BR, "%.2f GB", bytes / 1_073_741_824.0)

private const val FIRST_PLAY_MS = 16_000L

/**
 * What a hosted torrent must fetch before it plays: the gate's 10 s and the segment that
 * holds them, at the file's average bitrate. The swarm streams from the start, so it comes first.
 */
fun firstPlayBytes(fileBytes: Long, durationMs: Long): Long =
    if (durationMs <= 0) fileBytes else (fileBytes * (FIRST_PLAY_MS.toDouble() / durationMs).coerceAtMost(1.0)).toLong()

/** The host's own wait, from its swarm, once the probe knows how long the file runs. */
fun hostPreparation(swarm: SwarmStats?, durationMs: Long?): RoomPreparation? {
    val size = swarm?.selectedBytes?.takeIf { it > 0 } ?: return null
    val duration = durationMs?.takeIf { it > 0 } ?: return null
    return RoomPreparation(sourceBytes = size, receivedBytes = swarm.haveBytes, previewTargetBytes = firstPlayBytes(size, duration))
}

/** How far the preview got, 0..1, or null while nothing says. */
fun preparationProgress(prep: RoomPreparation?, durationMs: Long = 0): Float? {
    val received = prep?.receivedBytes ?: return null
    val target = prepTarget(prep, durationMs).bytes
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
    val english = englishLanguageName(language)
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


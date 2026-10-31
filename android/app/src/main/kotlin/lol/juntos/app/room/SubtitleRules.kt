package lol.juntos.app.room

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToLong

// web/src/player/subtitleDelay.ts
const val DELAY_STEP_MS = 250L
const val DELAY_LIMIT_MS = 600_000L
const val SUBTITLE_MAX_BYTES = 2 * 1024 * 1024

private fun clampDelay(ms: Long) = ms.coerceIn(-DELAY_LIMIT_MS, DELAY_LIMIT_MS)

fun stepDelay(ms: Long, direction: Int): Long = clampDelay(ms + direction * DELAY_STEP_MS)

fun formatDelay(ms: Long): String {
    val seconds = String.format(Locale.US, "%.2f", abs(ms) / 1000.0).replace('.', ',')
    val sign = if (ms > 0) "+" else if (ms < 0) "-" else ""
    return "$sign$seconds s"
}

/** The value the field opens with: the same number, unsigned when positive. */
fun editableDelay(ms: Long): String =
    (if (ms < 0) "-" else "") + String.format(Locale.US, "%.2f", abs(ms) / 1000.0).replace('.', ',')

private val NUMBER = Regex("^[+-]?\\d*\\.?\\d+$")

fun parseDelay(text: String): Long? {
    val cleaned = text.replace(Regex("\\s"), "").removeSuffix("s").removeSuffix("S").replace(',', '.')
    if (cleaned.isEmpty() || !NUMBER.matches(cleaned)) return null
    return clampDelay((cleaned.toDouble() * 1000).roundToLong())
}

/** A picked subtitle file as text: UTF-8 when it is valid, Windows-1252 otherwise; null past 2 MB. */
fun decodeSubtitle(bytes: ByteArray): String? {
    if (bytes.size > SUBTITLE_MAX_BYTES) return null
    val utf8 = Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
    val text = try {
        utf8.decode(ByteBuffer.wrap(bytes)).toString()
    } catch (e: CharacterCodingException) {
        String(bytes, charset("windows-1252"))
    }
    return text.removePrefix("﻿")
}

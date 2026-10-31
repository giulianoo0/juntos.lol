package lol.juntos.player

import java.util.Locale

// web/src/player/audioTracks.ts: ffmpeg passes "ger" or "deu" through as the container had it.
private val THREE_TO_TWO = mapOf(
    "alb" to "sq", "sqi" to "sq", "arm" to "hy", "hye" to "hy", "baq" to "eu", "eus" to "eu",
    "bur" to "my", "mya" to "my", "chi" to "zh", "zho" to "zh", "cze" to "cs", "ces" to "cs",
    "dut" to "nl", "nld" to "nl", "fre" to "fr", "fra" to "fr", "geo" to "ka", "kat" to "ka",
    "ger" to "de", "deu" to "de", "gre" to "el", "ell" to "el", "ice" to "is", "isl" to "is",
    "mac" to "mk", "mkd" to "mk", "mao" to "mi", "mri" to "mi", "may" to "ms", "msa" to "ms",
    "per" to "fa", "fas" to "fa", "rum" to "ro", "ron" to "ro", "slo" to "sk", "slk" to "sk",
    "tib" to "bo", "bod" to "bo", "wel" to "cy", "cym" to "cy",
    "afr" to "af", "ara" to "ar", "ben" to "bn", "bul" to "bg", "cat" to "ca", "dan" to "da",
    "eng" to "en", "est" to "et", "fin" to "fi", "glg" to "gl", "heb" to "he", "hin" to "hi",
    "hrv" to "hr", "hun" to "hu", "ind" to "id", "ita" to "it", "jpn" to "ja", "kor" to "ko",
    "lav" to "lv", "lit" to "lt", "nor" to "no", "pol" to "pl", "por" to "pt", "rus" to "ru",
    "slv" to "sl", "spa" to "es", "srp" to "sr", "swe" to "sv", "tam" to "ta", "tel" to "te",
    "tgl" to "tl", "tha" to "th", "tur" to "tr", "ukr" to "uk", "urd" to "ur", "vie" to "vi",
)

private val FFMPEG_PLACEHOLDER = Regex("^audio_\\d+$")

private val PT_BR: Locale = Locale.forLanguageTag("pt-BR")

/** "por" → "Português". Null when nothing can name it. */
fun languageLabel(code: String): String? {
    val base = code.trim().lowercase().replace('_', '-').substringBefore('-')
    if (base.isEmpty() || base == "und") return null
    val tag = THREE_TO_TWO[base] ?: base
    val name = Locale.forLanguageTag(tag).getDisplayLanguage(PT_BR)
    if (name.isBlank() || name.equals(tag, ignoreCase = true)) return null
    return name.replaceFirstChar { it.titlecase(PT_BR) }
}

/** The language wins over a name the encoder invented; the position is the last resort. */
fun audioTrackLabel(name: String?, language: String?, index: Int): String {
    val trimmed = name?.trim()
    if (!trimmed.isNullOrEmpty() && !FFMPEG_PLACEHOLDER.matches(trimmed)) return trimmed
    if (!language.isNullOrBlank()) return languageLabel(language) ?: language
    return (index + 1).toString()
}

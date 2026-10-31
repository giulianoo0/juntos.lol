package lol.juntos.player

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration

/** A subtitle line, in room time. */
data class SubtitleCue(val startMs: Long, val endMs: Long, val text: AnnotatedString)

fun activeCues(cues: List<SubtitleCue>, atMs: Long): List<SubtitleCue> =
    cues.filter { atMs >= it.startMs && atMs < it.endMs }

/** SRT, WebVTT, ASS or SSA, told apart by their content. Empty when nothing in it is a cue. */
fun parseSubtitles(file: String): List<SubtitleCue> {
    val text = file.removePrefix("﻿").replace("\r\n", "\n").replace('\r', '\n')
    val cues = if (DIALOGUE.containsMatchIn(text)) parseAss(text) else parseTimed(text)
    return cues.filter { it.endMs > it.startMs && it.text.isNotBlank() }.sortedBy { it.startMs }
}

private val DIALOGUE = Regex("^Dialogue:", RegexOption.MULTILINE)
private val TIMESTAMP = Regex("""(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})""")
private val ASS_TIME = Regex("""(\d+):(\d{2}):(\d{2})[.,](\d{1,3})""")
private val ASS_OVERRIDE = Regex("""\{[^}]*\}""")
private val TAG = Regex("""<(/?)([a-zA-Z]*)([^>]*)>""")

private fun fraction(digits: String) = digits.padEnd(3, '0').take(3).toLong()

private fun parseAss(text: String): List<SubtitleCue> {
    var fields = listOf("layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text")
    val cues = mutableListOf<SubtitleCue>()
    var inEvents = false
    for (line in text.lineSequence()) {
        val trimmed = line.trim()
        if (trimmed.startsWith("[")) inEvents = trimmed.equals("[Events]", ignoreCase = true)
        if (inEvents && trimmed.startsWith("Format:", ignoreCase = true)) {
            fields = trimmed.substringAfter(':').split(',').map { it.trim().lowercase() }
        }
        if (!trimmed.startsWith("Dialogue:")) continue
        val values = trimmed.substringAfter(':').split(',', limit = fields.size).map { it.trim() }
        if (values.size < fields.size) continue
        val start = assTime(values[fields.indexOf("start")]) ?: continue
        val end = assTime(values[fields.indexOf("end")]) ?: continue
        val body = values[fields.indexOf("text").takeIf { it >= 0 } ?: (fields.size - 1)]
            .replace(ASS_OVERRIDE, "")
            .replace("\\N", "\n")
            .replace("\\n", " ")
            .replace("\\h", " ")
            .trim()
        cues += SubtitleCue(start, end, AnnotatedString(body))
    }
    return cues
}

private fun assTime(value: String): Long? {
    val m = ASS_TIME.matchEntire(value.trim()) ?: return null
    val (h, min, s, cs) = m.destructured
    return ((h.toLong() * 60 + min.toLong()) * 60 + s.toLong()) * 1000 + fraction(cs)
}

private fun timestamp(m: MatchResult): Long {
    val (h, min, s, ms) = m.destructured
    return (((h.toLongOrNull() ?: 0) * 60 + min.toLong()) * 60 + s.toLong()) * 1000 + fraction(ms)
}

private fun parseTimed(text: String): List<SubtitleCue> {
    val cues = mutableListOf<SubtitleCue>()
    for (block in text.split(Regex("\n[ \t]*\n"))) {
        val lines = block.trim('\n').lines()
        val timing = lines.indexOfFirst { "-->" in it }
        if (timing < 0) continue
        val (from, to) = lines[timing].split("-->", limit = 2)
        val start = TIMESTAMP.find(from)?.let(::timestamp) ?: continue
        val end = TIMESTAMP.find(to)?.let(::timestamp) ?: continue
        val body = lines.drop(timing + 1).joinToString("\n").replace(ASS_OVERRIDE, "").trim()
        cues += SubtitleCue(start, end, markup(body))
    }
    return cues
}

/** <i>, <b>, <u>, <font color> and <c.class> become styles; every other tag (voices, timestamps) is dropped. */
private fun markup(body: String): AnnotatedString {
    val builder = AnnotatedString.Builder()
    val open = mutableListOf<Pair<String, Int>>()
    val spans = mutableListOf<Triple<SpanStyle, Int, String>>()
    var at = 0
    for (tag in TAG.findAll(body)) {
        builder.append(entities(body.substring(at, tag.range.first)))
        at = tag.range.last + 1
        val (slash, rawName, rest) = tag.destructured
        val name = rawName.lowercase()
        if (slash.isEmpty()) {
            val style = styleFor(name, rest) ?: continue
            spans += Triple(style, builder.length, name)
            open += name to spans.lastIndex
        } else {
            val i = open.indexOfLast { it.first == name }
            if (i < 0) continue
            val (style, start, _) = spans[open[i].second]
            builder.addStyle(style, start, builder.length)
            open.removeAt(i)
        }
    }
    builder.append(entities(body.substring(at)))
    for ((_, span) in open) {
        val (style, start, _) = spans[span]
        builder.addStyle(style, start, builder.length)
    }
    return builder.toAnnotatedString()
}

private fun styleFor(name: String, rest: String): SpanStyle? = when (name) {
    "i" -> SpanStyle(fontStyle = FontStyle.Italic)
    "b" -> SpanStyle(fontWeight = FontWeight.Bold)
    "u" -> SpanStyle(textDecoration = TextDecoration.Underline)
    "font" -> Regex("""color\s*=\s*["']?([#\w]+)""", RegexOption.IGNORE_CASE).find(rest)
        ?.let { color(it.groupValues[1]) }?.let { SpanStyle(color = it) } ?: SpanStyle()
    "c" -> rest.split('.').drop(1).firstNotNullOfOrNull { color(it.trim()) }?.let { SpanStyle(color = it) } ?: SpanStyle()
    else -> null
}

private val NAMED = mapOf(
    "white" to 0xFFFFFF, "black" to 0x000000, "red" to 0xFF0000, "lime" to 0x00FF00, "green" to 0x008000,
    "blue" to 0x0000FF, "yellow" to 0xFFFF00, "cyan" to 0x00FFFF, "aqua" to 0x00FFFF, "magenta" to 0xFF00FF,
    "fuchsia" to 0xFF00FF, "silver" to 0xC0C0C0, "gray" to 0x808080, "grey" to 0x808080, "maroon" to 0x800000,
    "olive" to 0x808000, "navy" to 0x000080, "purple" to 0x800080, "teal" to 0x008080, "orange" to 0xFFA500,
)

private fun color(value: String): Color? {
    val v = value.lowercase()
    NAMED[v]?.let { return Color(0xFF000000 or it.toLong()) }
    val hex = v.removePrefix("#")
    if (!hex.all { it in '0'..'9' || it in 'a'..'f' }) return null
    val rgb = when (hex.length) {
        3 -> hex.map { "$it$it" }.joinToString("")
        6 -> hex
        else -> return null
    }
    return Color(0xFF000000 or rgb.toLong(16))
}

private fun entities(text: String) = text
    .replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", " ")
    .replace("&quot;", "\"").replace("&#39;", "'").replace("&lrm;", "‎").replace("&rlm;", "‏")
    .replace("&amp;", "&")

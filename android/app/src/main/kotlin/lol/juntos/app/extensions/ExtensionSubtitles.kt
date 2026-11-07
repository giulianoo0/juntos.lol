package lol.juntos.app.extensions

import android.util.Log
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import lol.juntos.app.room.decodeSubtitle
import lol.juntos.core.api.JuntosApi
import lol.juntos.core.extensions.ExtSubtitle
import lol.juntos.core.model.Seat
import lol.juntos.player.SubtitleCue
import lol.juntos.player.parseSubtitles

private const val MAX_SUBTITLE_BYTES = 2 * 1024 * 1024

private fun stamp(ms: Long): String =
    "%02d:%02d:%02d.%03d".format(java.util.Locale.ROOT, ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000)

private fun escape(text: String) = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("-->", "--&gt;")

/** A cue's words with its italics and bold as WebVTT tags. */
private fun cueText(cue: SubtitleCue): String {
    val text = cue.text.text
    val opens = sortedMapOf<Int, StringBuilder>()
    val closes = sortedMapOf<Int, StringBuilder>()
    for (span in cue.text.spanStyles) {
        val tag = when {
            span.item.fontStyle == FontStyle.Italic -> "i"
            span.item.fontWeight == FontWeight.Bold -> "b"
            else -> continue
        }
        opens.getOrPut(span.start, ::StringBuilder).append("<$tag>")
        closes.getOrPut(span.end, ::StringBuilder).insert(0, "</$tag>")
    }
    val out = StringBuilder()
    for (i in 0..text.length) {
        closes[i]?.let(out::append)
        opens[i]?.let(out::append)
        if (i < text.length) out.append(escape(text[i].toString()))
    }
    return out.toString().lines().filter { it.isNotBlank() }.joinToString("\n")
}

/** SRT, WebVTT, ASS or SSA as the WebVTT the room keeps; null when nothing in it is a cue. */
fun subtitleAsVtt(file: String): String? {
    val cues = parseSubtitles(file)
    if (cues.isEmpty()) return null
    return buildString {
        append("WEBVTT\n")
        for (cue in cues) {
            val text = cueText(cue)
            if (text.isNotBlank()) append("\n${stamp(cue.startMs)} --> ${stamp(cue.endMs)}\n$text\n")
        }
    }
}

/**
 * The subtitles an extension sent with play, read here and imported for the whole room,
 * as the site's importExtensionSubtitles: one that cannot be read is skipped, the video
 * plays all the same.
 */
suspend fun importExtensionSubtitles(api: JuntosApi, roomId: String, seat: Seat, mediaGeneration: Int, subtitles: List<ExtSubtitle>): Int {
    var imported = 0
    for (subtitle in subtitles) {
        runCatching {
            val bytes = api.fetchBytes(subtitle.url, MAX_SUBTITLE_BYTES) ?: return@runCatching
            val vtt = decodeSubtitle(bytes)?.let(::subtitleAsVtt) ?: return@runCatching
            api.importSubtitle(roomId, seat, mediaGeneration, subtitle.lang, subtitle.label ?: subtitle.lang, vtt)
            imported++
        }.onFailure { Log.w("ExtensionSubtitles", "skipped ${subtitle.url}", it) }
    }
    return imported
}

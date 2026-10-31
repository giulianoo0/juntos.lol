package lol.juntos.player

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SubtitleParserTest {
    private data class Case(val name: String, val file: String, val cues: List<Triple<Long, Long, String>>)

    private val cases = listOf(
        Case(
            "SRT with a BOM, CRLF and two lines",
            "﻿1\r\n00:00:01,000 --> 00:00:02,500\r\nOlá\r\nmundo\r\n\r\n2\r\n01:02:03,040 --> 01:02:04,000\r\nTchau\r\n",
            listOf(Triple(1_000L, 2_500L, "Olá\nmundo"), Triple(3_723_040L, 3_724_000L, "Tchau")),
        ),
        Case(
            "VTT with a header, a note, ids and position settings",
            "WEBVTT - legendas\nKind: captions\n\nNOTE isto não é cue\n\nabc\n00:01.000 --> 00:02.000 align:start position:10% line:0\nCurta\n\n00:00:03.000 --> 00:00:04.000\n<v Ana>Fala</v> &amp; <c.yellow>cor</c> <00:00:03.500>fim\n",
            listOf(Triple(1_000L, 2_000L, "Curta"), Triple(3_000L, 4_000L, "Fala & cor fim")),
        ),
        Case(
            "ASS keeps only the text of each Dialogue",
            "[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" +
                "Dialogue: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,{\\an8\\b1}Em cima,\\Ndois{\\i1} pontos\n" +
                "Comment: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,ignorado\n" +
                "Dialogue: 0,1:00:00.00,1:00:01.00,Default,,0,0,0,,linha\\nsuave\n",
            listOf(Triple(1_500L, 3_000L, "Em cima,\ndois pontos"), Triple(3_600_000L, 3_601_000L, "linha suave")),
        ),
        Case(
            "SSA with a Marked field reads the same",
            "[Events]\nFormat: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: Marked=0,0:00:02.00,0:00:03.00,*Default,,0,0,0,,Velho\n",
            listOf(Triple(2_000L, 3_000L, "Velho")),
        ),
        Case("a file without cues", "isto não é legenda", emptyList()),
    )

    @Test
    fun `each format parses to timed plain text`() {
        for (case in cases) {
            val cues = parseSubtitles(case.file)
            assertEquals(case.name, case.cues, cues.map { Triple(it.startMs, it.endMs, it.text.text) })
        }
    }

    @Test
    fun `cues come out sorted by start`() {
        val cues = parseSubtitles("00:00:05.000 --> 00:00:06.000\nB\n\n00:00:01.000 --> 00:00:02.000\nA\n")
        assertEquals(listOf("A", "B"), cues.map { it.text.text })
    }

    @Test
    fun `srt tags become styles over the text they wrap`() {
        val cue = parseSubtitles("1\n00:00:01,000 --> 00:00:02,000\n<i>it</i> <b>bo</b> <u>un</u> <font color=\"#ff0000\">red</font> <font color=yellow>yel</font>\n").single()
        val text = cue.text
        assertEquals("it bo un red yel", text.text)
        fun styleOf(word: String) = text.spanStyles.filter { it.start <= text.text.indexOf(word) && it.end >= text.text.indexOf(word) + word.length }.map { it.item }
        assertTrue(styleOf("it").any { it.fontStyle == FontStyle.Italic })
        assertTrue(styleOf("bo").any { it.fontWeight == FontWeight.Bold })
        assertTrue(styleOf("un").any { it.textDecoration == TextDecoration.Underline })
        assertTrue(styleOf("red").any { it.color == Color(0xFFFF0000) })
        assertTrue(styleOf("yel").any { it.color == Color(0xFFFFFF00) })
        assertTrue(styleOf("it").none { it.color != Color.Unspecified })
    }

    @Test
    fun `a vtt color class colors its text`() {
        val text = parseSubtitles("WEBVTT\n\n00:01.000 --> 00:02.000\n<c.cyan.bold>ci</c>ano\n").single().text
        assertEquals("ciano", text.text)
        assertTrue(text.spanStyles.any { it.item.color == Color(0xFF00FFFF) && it.start == 0 && it.end == 2 })
    }

    @Test
    fun `the active cues are the ones holding a time`() {
        val cues = parseSubtitles("00:00:01.000 --> 00:00:03.000\nA\n\n00:00:02.000 --> 00:00:04.000\nB\n")
        assertEquals(listOf("A"), activeCues(cues, 1_500).map { it.text.text })
        assertEquals(listOf("A", "B"), activeCues(cues, 2_500).map { it.text.text })
        assertEquals(emptyList<String>(), activeCues(cues, 4_000).map { it.text.text })
    }
}

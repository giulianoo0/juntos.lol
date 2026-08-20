package media

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestConvertASSToVTTKeepsPlacementAndColor(t *testing.T) {
	doc := strings.Join([]string{
		"[Script Info]",
		"ScriptType: v4.00+",
		"PlayResX: 1920",
		"PlayResY: 1080",
		"",
		"[V4+ Styles]",
		"Format: Name, Fontname, PrimaryColour, Bold, Italic, Alignment",
		"Style: Default,Lato,&H00FFFFFF,0,0,2",
		"Style: Signs,Lato,&H0000FFFF,0,0,8",
		"Style: Thoughts,Lato,&H00FFFFFF,0,-1,2",
		"",
		"[Events]",
		"Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
		"Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,Uma fala, comum",
		"Dialogue: 0,0:00:03.00,0:00:04.00,Signs,,0,0,0,,{\\pos(960,108)}Ateliê",
		"Dialogue: 0,0:00:05.00,0:00:06.00,Thoughts,,0,0,0,,{\\i0}dito {\\r}pensado",
		"Dialogue: 0,0:00:07.00,0:00:08.00,Default,,0,0,0,,{\\an8}no topo\\Nsegunda",
		"Dialogue: 0,0:00:09.00,0:00:10.00,Default,,0,0,0,,{\\c&H4020E0&}sangue{\\c} e água",
		"Dialogue: 0,0:00:11.00,0:00:12.00,Signs,,0,0,0,,{\\p1}m 0 0 l 10 0{\\p0}",
		"Dialogue: 0,0:00:15.00,0:00:16.00,Default,,0,0,0,,{\\pos(480,270)}placa baixa",
		"Comment: 0,0:00:13.00,0:00:14.00,Default,,0,0,0,,ignorado",
	}, "\n")

	vtt := string(ConvertASSToVTT([]byte(doc)))

	require.True(t, strings.HasPrefix(vtt, "WEBVTT\n"))
	require.Contains(t, vtt, "00:00:01.000 --> 00:00:02.500\nUma fala, comum\n")
	// The sign keeps its script-frame position and its quantized color.
	require.Contains(t, vtt, "00:00:03.000 --> 00:00:04.000 line:10% position:50%\n<c.yellow>Ateliê</c>\n")
	// The style's italic is the baseline; \i0 leaves it and \r comes back.
	require.Contains(t, vtt, "00:00:05.000 --> 00:00:06.000\ndito <i>pensado</i>\n")
	require.Contains(t, vtt, "00:00:07.000 --> 00:00:08.000 line:5%\nno topo\nsegunda\n")
	require.Contains(t, vtt, "00:00:09.000 --> 00:00:10.000\n<c.red>sangue</c> e água\n")
	// A bottom-row \pos names the text's bottom edge; the box's top edge is
	// lifted a nominal text height because Chromium rejects the alignment
	// suffix that would say this properly.
	require.Contains(t, vtt, "00:00:15.000 --> 00:00:16.000 line:19% position:25%\nplaca baixa\n")
	// A vector drawing renders as garbage letters if kept as text.
	require.NotContains(t, vtt, "m 0 0")
	require.NotContains(t, vtt, "ignorado")
}

func TestConvertASSToVTTEscapesMarkup(t *testing.T) {
	doc := strings.Join([]string{
		"[Events]",
		"Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
		"Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,a < b & b > c",
	}, "\n")

	vtt := string(ConvertASSToVTT([]byte(doc)))

	require.Contains(t, vtt, "a &lt; b &amp; b &gt; c")
}

func TestConvertASSToVTTSortsCuesAndSkipsATruncatedTail(t *testing.T) {
	// The progressive extraction converts a file ffmpeg is still writing, so
	// the last line is routinely cut mid-field.
	doc := strings.Join([]string{
		"[Events]",
		"Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
		"Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,depois",
		"Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,antes",
		"Dialogue: 0,0:00:07.00,0:0",
	}, "\n")

	vtt := string(ConvertASSToVTT([]byte(doc)))

	require.Less(t, strings.Index(vtt, "antes"), strings.Index(vtt, "depois"))
	require.NotContains(t, vtt, "00:00:07")
}

func TestConvertASSToVTTReturnsNothingWithoutCues(t *testing.T) {
	require.Empty(t, ConvertASSToVTT([]byte("[Script Info]\nTitle: vazio\n")))
}

package media

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestIsSubtitleFileName(t *testing.T) {
	for _, name := range []string{"a.srt", "a.ASS", "a.ssa", "a.vtt", "a.sub"} {
		require.True(t, IsSubtitleFileName(name), name)
	}
	for _, name := range []string{"a.mkv", "a.jpg", "a.srt.mkv", "subtitles"} {
		require.False(t, IsSubtitleFileName(name), name)
	}
}

func TestSubtitleIdentityReadsTheLanguageOutOfReleaseNames(t *testing.T) {
	cases := map[string]string{
		"Movie.2019.1080p.eng.srt":        "eng",
		"Movie.English.srt":               "eng",
		"Movie.en.srt":                    "eng",
		"Subs/Show - 01 [portuguese].ass": "por",
		"Show.S01E01.pt-BR.srt":           "pt-br",
		"Show.S01E01.srt":                 "und",
		// A language-looking token early in the name loses to the later one,
		// which is where releases actually put it.
		"German.Movie.1080p.eng.srt": "eng",
	}
	for name, want := range cases {
		language, _ := SubtitleIdentity(name)
		require.Equal(t, want, language, name)
	}
}

func TestSubtitleIdentityAlwaysNamesTheTrack(t *testing.T) {
	_, title := SubtitleIdentity("Subs/Movie.2019.eng.srt")
	require.Equal(t, "Movie 2019 eng", title)

	_, empty := SubtitleIdentity(".srt")
	require.Equal(t, "Subtitle", empty)
}

func TestDecodeSubtitleBytesKeepsValidUTF8(t *testing.T) {
	text := []byte("olá, mundo")
	require.Equal(t, text, decodeSubtitleBytes(text))
	// A BOM is stripped so it never leaks into the first cue.
	require.Equal(t, text, decodeSubtitleBytes(append([]byte{0xEF, 0xBB, 0xBF}, text...)))
}

func TestDecodeSubtitleBytesRecoversLatin1(t *testing.T) {
	// "olá" as Windows-1252 is invalid UTF-8, and rendering it raw would show
	// a replacement character in the middle of a caption.
	require.Equal(t, []byte("olá"), decodeSubtitleBytes([]byte{'o', 'l', 0xE1}))
}

func TestConvertSideSubtitlesKeepsStyledSigns(t *testing.T) {
	script := "[Script Info]\n" +
		"PlayResX: 1920\n" +
		"PlayResY: 1080\n" +
		"[V4+ Styles]\n" +
		"Format: Name, PrimaryColour, Bold, Italic, Alignment\n" +
		"Style: Signs,&H0000FFFF,0,0,8\n" +
		"[Events]\n" +
		"Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" +
		"Dialogue: 0,0:00:01.00,0:00:02.00,Signs,,0,0,0,,{\\pos(960,108)}Ateliê\n"

	converted, err := ConvertSideSubtitles(t.Context(), t.TempDir(),
		map[string][]byte{"Subs/English.ass": []byte(script)})

	require.NoError(t, err)
	require.Len(t, converted, 1)
	// The sidecar goes through the same converter as the muxed tracks, so its
	// placement and color survive instead of being flattened by ffmpeg.
	require.Contains(t, string(converted[0].VTT),
		"00:00:01.000 --> 00:00:02.000 line:10% position:50%\n<c.yellow>Ateliê</c>")
}

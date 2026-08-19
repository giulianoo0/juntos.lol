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

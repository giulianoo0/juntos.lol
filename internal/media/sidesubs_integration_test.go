//go:build integration

package media

import (
	"os/exec"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

const sampleSRT = `1
00:00:01,000 --> 00:00:03,000
Olá, mundo

2
00:00:04,500 --> 00:00:06,000
Segunda legenda
`

func TestConvertSideSubtitlesProducesWebVTT(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}

	converted, err := ConvertSideSubtitles(t.Context(), t.TempDir(), map[string][]byte{
		"Movie.2019.eng.srt": []byte(sampleSRT),
		"Movie.2019.por.srt": []byte(sampleSRT),
	})
	require.NoError(t, err)
	require.Len(t, converted, 2)

	// Sorted by name, so the indexes are stable across runs over the same
	// torrent and a republish never renumbers the tracks.
	require.Equal(t, "eng", converted[0].Track.Language)
	require.Equal(t, "por", converted[1].Track.Language)
	require.Equal(t, 0, converted[0].Track.Index)
	require.Equal(t, 1, converted[1].Track.Index)

	for _, subtitle := range converted {
		require.True(t, strings.HasPrefix(string(subtitle.VTT), "WEBVTT"), string(subtitle.VTT))
		require.Contains(t, string(subtitle.VTT), "Olá, mundo")
		require.Equal(t, "webvtt", subtitle.Track.Codec)
	}
}

func TestConvertSideSubtitlesSkipsWhatItCannotRead(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}

	// One unusable file must not cost the room the subtitles that do work.
	converted, err := ConvertSideSubtitles(t.Context(), t.TempDir(), map[string][]byte{
		"a.broken.srt": []byte("this is not a subtitle file at all"),
		"b.eng.srt":    []byte(sampleSRT),
	})
	require.NoError(t, err)
	require.Len(t, converted, 1)
	require.Equal(t, "eng", converted[0].Track.Language)
	require.Equal(t, 0, converted[0].Track.Index)
}

package media

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/room"
)

func sideSubtitle(language, title, body string) SideSubtitle {
	return SideSubtitle{
		Track: room.TrackInfo{Language: language, Title: title, Codec: "webvtt"},
		VTT:   []byte("WEBVTT\n\n" + body),
	}
}

func TestStoreExternalSubtitlesPublishesThemImmediately(t *testing.T) {
	subsDir := filepath.Join(t.TempDir(), "subs")
	require.NoError(t, os.MkdirAll(subsDir, 0o755))

	tracks, err := StoreExternalSubtitles(subsDir, []SideSubtitle{
		sideSubtitle("eng", "English", "one"),
		sideSubtitle("por", "Português", "dois"),
	})
	require.NoError(t, err)
	require.Len(t, tracks, 2)

	// Named by position, which is what the player asks for.
	for name, want := range map[string]string{
		"sub_0_eng.vtt": "one",
		"sub_1_por.vtt": "dois",
	} {
		data, err := os.ReadFile(filepath.Join(subsDir, name))
		require.NoError(t, err, name)
		require.Contains(t, string(data), want)
	}
}

func TestMergeExternalSubtitlesPutsThemAfterTheEmbeddedOnes(t *testing.T) {
	subsDir := filepath.Join(t.TempDir(), "subs")
	require.NoError(t, os.MkdirAll(subsDir, 0o755))
	_, err := StoreExternalSubtitles(subsDir, []SideSubtitle{
		sideSubtitle("eng", "English", "external one"),
		sideSubtitle("por", "Português", "external two"),
	})
	require.NoError(t, err)

	// The final pass wrote two embedded tracks over the low positions, which
	// is exactly how the sibling files used to be lost.
	embedded := []room.TrackInfo{
		{Index: 0, Language: "jpn", Title: "Japanese", Codec: "subrip"},
		{Index: 1, Language: "spa", Title: "Spanish", Codec: "subrip"},
	}
	for position, track := range embedded {
		require.NoError(t, os.WriteFile(
			filepath.Join(subsDir, publishedSubtitleName(position, track.Language)),
			[]byte("WEBVTT\n\nembedded"), 0o644))
	}

	merged, err := MergeExternalSubtitles(subsDir, embedded)
	require.NoError(t, err)
	require.Len(t, merged, 4)
	require.Equal(t, []string{"jpn", "spa", "eng", "por"},
		[]string{merged[0].Language, merged[1].Language, merged[2].Language, merged[3].Language})
	for position, track := range merged {
		require.Equal(t, position, track.Index)
	}

	// The sibling subtitles survive, at their new positions.
	third, err := os.ReadFile(filepath.Join(subsDir, "sub_2_eng.vtt"))
	require.NoError(t, err)
	require.Contains(t, string(third), "external one")
	fourth, err := os.ReadFile(filepath.Join(subsDir, "sub_3_por.vtt"))
	require.NoError(t, err)
	require.Contains(t, string(fourth), "external two")
}

func TestMergeExternalSubtitlesWithoutAnyIsTheEmbeddedList(t *testing.T) {
	subsDir := filepath.Join(t.TempDir(), "subs")
	require.NoError(t, os.MkdirAll(subsDir, 0o755))
	embedded := []room.TrackInfo{{Index: 0, Language: "eng"}}

	merged, err := MergeExternalSubtitles(subsDir, embedded)
	require.NoError(t, err)
	require.Equal(t, embedded, merged)
}

func TestStoreExternalSubtitlesSanitizesTheLanguageInFileNames(t *testing.T) {
	subsDir := filepath.Join(t.TempDir(), "subs")
	require.NoError(t, os.MkdirAll(subsDir, 0o755))

	// A language read out of a torrent file name must never reach the
	// filesystem unchecked.
	_, err := StoreExternalSubtitles(subsDir, []SideSubtitle{sideSubtitle("../../etc/x", "Odd", "x")})
	require.NoError(t, err)

	_, err = os.Stat(filepath.Join(subsDir, "sub_0_und.vtt"))
	require.NoError(t, err)
}

package media

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/room"
)

func TestBuildProgressiveSubtitleArgsWritesOnePerTrack(t *testing.T) {
	probe := &ProbeResult{Subtitles: []room.TrackInfo{
		{Index: 0, Language: "eng"},
		{Index: 2, Language: "por"},
	}}

	args, outputs := buildProgressiveSubtitleArgs("pipe:0", "/tmp/subs", probe)
	joined := strings.Join(args, " ")

	// The stream index comes from the probe, the file name from the position:
	// the player asks for tracks by their place in the room's list.
	require.Contains(t, joined, "-map 0:s:0")
	require.Contains(t, joined, "-map 0:s:2")
	require.Equal(t, []string{"/tmp/subs/sub_0_eng.vtt", "/tmp/subs/sub_1_por.vtt"}, outputs)
	// Without this ffmpeg holds cues back for minutes, which defeats the point.
	require.Contains(t, joined, "-flush_packets 1")
}

func TestHasSubtitleCuesIgnoresAHeaderWithNothingUnderIt(t *testing.T) {
	dir := t.TempDir()
	empty := filepath.Join(dir, "empty.vtt")
	require.NoError(t, os.WriteFile(empty, []byte("WEBVTT\n\n"), 0o644))
	// ffmpeg writes the header the moment it opens the file, so publishing on
	// existence alone would offer viewers a track with no cues in it.
	require.False(t, hasSubtitleCues(empty))

	withCue := filepath.Join(dir, "one.vtt")
	require.NoError(t, os.WriteFile(withCue,
		[]byte("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nolá\n"), 0o644))
	require.True(t, hasSubtitleCues(withCue))

	require.False(t, hasSubtitleCues(filepath.Join(dir, "missing.vtt")))
}

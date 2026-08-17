package media

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/giulianoo0/ss/internal/room"
	"github.com/stretchr/testify/require"
)

func TestBuildSubtitleCommand(t *testing.T) {
	tests := []struct {
		name     string
		position int
		track    room.TrackInfo
		wantFile string
	}{
		{
			name:     "language retained",
			position: 0,
			track:    room.TrackInfo{Index: 2, Language: "pt-BR"},
			wantFile: "sub_0_pt-BR.vtt",
		},
		{
			name:     "unsafe language omitted from filename",
			position: 1,
			track:    room.TrackInfo{Index: 4, Language: "../../escape"},
			wantFile: "sub_1_und.vtt",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			args, output := buildSubtitleCommand("/rooms/r/original.mkv", "/rooms/r/subs", tt.position, tt.track)

			require.Equal(t, filepath.Join("/rooms/r/subs", tt.wantFile), output)
			require.Equal(t, []string{
				"-hide_banner", "-loglevel", "error", "-y",
				"-i", "/rooms/r/original.mkv",
				"-map", "0:s:" + strconv.Itoa(tt.track.Index),
				"-c:s", "webvtt", output,
			}, args)
		})
	}
}

func TestExtractSubtitlesReturnsProcessStartError(t *testing.T) {
	p := &ProbeResult{Subtitles: []room.TrackInfo{{Index: 0, Language: "eng"}}}

	_, err := extractSubtitles(t.Context(), filepath.Join(t.TempDir(), "missing-ffmpeg"), "in.mkv", t.TempDir(), p)

	require.Error(t, err)
	require.ErrorContains(t, err, "start ffmpeg")
}

func TestExtractSubtitlesCancellationRemovesPartialOutput(t *testing.T) {
	binary, err := os.Executable()
	require.NoError(t, err)
	outDir := t.TempDir()
	p := &ProbeResult{Subtitles: []room.TrackInfo{{Index: 0, Language: "eng"}}}
	_, output := buildSubtitleCommand("in.mkv", outDir, 0, p.Subtitles[0])
	require.NoError(t, os.WriteFile(output, []byte("partial"), 0o644))
	ctx, cancel := context.WithCancel(t.Context())
	cancel()

	_, err = extractSubtitles(ctx, binary, "in.mkv", outDir, p)

	require.ErrorIs(t, err, context.Canceled)
	_, statErr := os.Stat(output)
	require.ErrorIs(t, statErr, os.ErrNotExist)
}

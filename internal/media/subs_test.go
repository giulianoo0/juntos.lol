package media

import (
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

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
		name      string
		position  int
		track     room.TrackInfo
		wantFile  string
		wantCodec string
	}{
		{
			name:      "language retained",
			position:  0,
			track:     room.TrackInfo{Index: 2, Language: "pt-BR", Codec: "subrip"},
			wantFile:  "sub_0_pt-BR.vtt",
			wantCodec: "webvtt",
		},
		{
			name:      "unsafe language omitted from filename",
			position:  1,
			track:     room.TrackInfo{Index: 4, Language: "../../escape", Codec: "subrip"},
			wantFile:  "sub_1_und.vtt",
			wantCodec: "webvtt",
		},
		{
			// ffmpeg's webvtt encoder drops placement and color, so a styled
			// track is extracted as ASS and converted by this package instead.
			name:      "styled track extracted as ASS",
			position:  2,
			track:     room.TrackInfo{Index: 5, Language: "eng", Codec: "ass"},
			wantFile:  "sub_2_eng.ass",
			wantCodec: "ass",
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
				"-c:s", tt.wantCodec, output,
			}, args)
		})
	}
}

func TestConvertStyledSubtitleRewritesToVTT(t *testing.T) {
	dir := t.TempDir()
	assPath := filepath.Join(dir, "sub_0_eng.ass")
	require.NoError(t, os.WriteFile(assPath, []byte(
		"[V4+ Styles]\n"+
			"Format: Name, PrimaryColour, Bold, Italic, Alignment\n"+
			"Style: Signs,&H0000FFFF,0,0,8\n"+
			"[Events]\n"+
			"Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"+
			"Dialogue: 0,0:00:01.00,0:00:02.00,Signs,,0,0,0,,placa\n"), 0o644))

	vttPath, err := convertStyledSubtitle(assPath)

	require.NoError(t, err)
	require.Equal(t, filepath.Join(dir, "sub_0_eng.vtt"), vttPath)
	vtt, err := os.ReadFile(vttPath)
	require.NoError(t, err)
	require.Contains(t, string(vtt), "line:5%\n<c.yellow>placa</c>")
	// The intermediate script must not linger where the publisher scans.
	_, statErr := os.Stat(assPath)
	require.ErrorIs(t, statErr, os.ErrNotExist)
}

func TestConvertStyledSubtitleRefusesAnEmptyScript(t *testing.T) {
	dir := t.TempDir()
	assPath := filepath.Join(dir, "sub_0_eng.ass")
	require.NoError(t, os.WriteFile(assPath, []byte("[Script Info]\nTitle: vazio\n"), 0o644))

	_, err := convertStyledSubtitle(assPath)

	require.Error(t, err)
	_, statErr := os.Stat(assPath)
	require.ErrorIs(t, statErr, os.ErrNotExist)
}

func TestPositionSubtitleFileLiftsDialogueInPlace(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub_0_eng.vtt")
	require.NoError(t, os.WriteFile(path,
		[]byte("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nfala\n"), 0o644))

	require.NoError(t, positionSubtitleFile(path))

	vtt, err := os.ReadFile(path)
	require.NoError(t, err)
	require.Contains(t, string(vtt), "00:00:01.000 --> 00:00:02.000 line:-3\nfala")
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

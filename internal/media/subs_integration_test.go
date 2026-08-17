//go:build integration

package media

import (
	"bytes"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/giulianoo0/ss/internal/room"
	"github.com/stretchr/testify/require"
)

func TestExtractSubtitles(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe not installed")
	}

	dir := t.TempDir()
	srt := filepath.Join(dir, "fixture.srt")
	require.NoError(t, os.WriteFile(srt, []byte("1\n00:00:00,000 --> 00:00:00,800\nHello\n"), 0o644))
	src := filepath.Join(dir, "in.mkv")
	gen := exec.CommandContext(t.Context(), "ffmpeg",
		"-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "testsrc2=duration=1:size=160x120:rate=5",
		"-i", srt,
		"-map", "0:v", "-map", "1:s",
		"-c:v", "libx264", "-c:s", "srt",
		"-metadata:s:s:0", "language=eng",
		"-shortest", src,
	)
	output, err := gen.CombinedOutput()
	require.NoError(t, err, string(output))

	p, err := Probe(t.Context(), src)
	require.NoError(t, err)
	require.Len(t, p.Subtitles, 1)
	p.Subtitles = append([]room.TrackInfo{{Index: 99, Language: "bad"}}, p.Subtitles...)

	outDir := filepath.Join(dir, "subs")
	originalLogger := slog.Default()
	var logs bytes.Buffer
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(originalLogger) })
	paths, err := ExtractSubtitles(t.Context(), src, outDir, p)
	require.NoError(t, err)
	require.Contains(t, logs.String(), "track_index=99")
	require.Equal(t, []string{filepath.Join(outDir, "sub_1_eng.vtt")}, paths)
	content, err := os.ReadFile(paths[0])
	require.NoError(t, err)
	require.Contains(t, string(content), "WEBVTT")
}

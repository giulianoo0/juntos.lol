//go:build integration

package media

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestRemuxIntegration(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe not installed")
	}

	dir := t.TempDir()
	src := filepath.Join(dir, "in.mkv")
	gen := exec.CommandContext(t.Context(), "ffmpeg",
		"-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "testsrc2=duration=2:size=320x240:rate=10",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=2",
		"-f", "lavfi", "-i", "sine=frequency=880:duration=2",
		"-map", "0:v", "-map", "1:a", "-map", "2:a",
		"-c:v", "libx264", "-c:a", "aac", "-shortest", src,
	)
	output, err := gen.CombinedOutput()
	require.NoError(t, err, string(output))

	p, err := Probe(t.Context(), src)
	require.NoError(t, err)
	require.Len(t, p.Audio, 2)

	out := filepath.Join(dir, "hls")
	require.NoError(t, os.MkdirAll(out, 0o755))
	require.NoError(t, Remux(t.Context(), src, out, p))

	master, err := os.ReadFile(filepath.Join(out, "master.m3u8"))
	require.NoError(t, err)
	require.Contains(t, string(master), "EXT-X-MEDIA")
	require.Contains(t, string(master), "TYPE=AUDIO")
	require.Contains(t, string(master), `GROUP-ID="group_audio"`)
	require.Contains(t, string(master), `AUDIO="group_audio"`)
	matches, err := filepath.Glob(filepath.Join(out, "*.m4s"))
	require.NoError(t, err)
	require.NotEmpty(t, matches)
}

func TestProgressiveRemuxIntegration(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe not installed")
	}

	dir := t.TempDir()
	src := filepath.Join(dir, "growing.mkv")
	gen := exec.CommandContext(t.Context(), "ffmpeg",
		"-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "testsrc2=duration=8:size=320x240:rate=10",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=8",
		"-c:v", "libx264", "-g", "10", "-keyint_min", "10", "-sc_threshold", "0",
		"-c:a", "aac", "-shortest", src,
	)
	output, err := gen.CombinedOutput()
	require.NoError(t, err, string(output))

	probe, err := Probe(t.Context(), src)
	require.NoError(t, err)
	out := filepath.Join(dir, "hls")
	require.NoError(t, os.MkdirAll(out, 0o755))

	ctx, cancel := context.WithCancel(t.Context())
	cmd := exec.CommandContext(ctx, "ffmpeg", BuildProgressiveRemuxArgs("pipe:0", out, probe)...)
	stdin, err := cmd.StdinPipe()
	require.NoError(t, err)
	require.NoError(t, cmd.Start())
	inputDone := make(chan error, 1)
	go func() {
		inputDone <- streamGrowingFile(ctx, src, stdin, time.Millisecond)
	}()

	require.Eventually(t, func() bool { return progressiveOutputReady(out) }, 10*time.Second, 50*time.Millisecond)
	cancel()
	_ = stdin.Close()
	_ = cmd.Wait()
	require.Error(t, <-inputDone)
}

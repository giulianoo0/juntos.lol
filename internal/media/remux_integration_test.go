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

	// This test drives ffmpeg directly, with no publisher behind it, so what
	// it can check is what ffmpeg wrote: a master, a variant playlist, an init
	// segment and a media segment.
	require.Eventually(t, func() bool { return ffmpegWroteAPlayableSet(out) }, 10*time.Second, 50*time.Millisecond)
	cancel()
	_ = stdin.Close()
	_ = cmd.Wait()
	require.Error(t, <-inputDone)
}

func ffmpegWroteAPlayableSet(hlsDir string) bool {
	if info, err := os.Stat(filepath.Join(hlsDir, "master.m3u8")); err != nil || info.Size() == 0 {
		return false
	}
	for _, pattern := range []string{"preview_stream_*.m3u8", "preview_init_*.mp4", "preview_stream_*.m4s"} {
		matches, err := filepath.Glob(filepath.Join(hlsDir, pattern))
		if err != nil || len(matches) == 0 {
			return false
		}
		found := false
		for _, match := range matches {
			if info, err := os.Stat(match); err == nil && info.Size() > 0 {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

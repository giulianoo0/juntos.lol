//go:build integration

package media

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// hevcSource renders a short HEVC clip with one audio track.
func hevcSource(t *testing.T, dir string) string {
	t.Helper()
	path := filepath.Join(dir, "src.mkv")
	cmd := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=2",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=2",
		"-c:v", "libx265", "-x265-params", "log-level=none", "-preset", "ultrafast",
		"-c:a", "aac", path)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("libx265 unavailable: %v: %s", err, output)
	}
	return path
}

// A copied HEVC track is the case ffmpeg leaves unlabelled, which is what
// makes it fail late and invisibly in players that cannot decode it.
func TestRemuxLabelsCopiedHEVCIntegration(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe not installed")
	}
	dir := t.TempDir()
	src := hevcSource(t, dir)

	probe, err := Probe(context.Background(), src)
	require.NoError(t, err)
	require.Equal(t, "hevc", probe.VideoCodec)
	require.True(t, probe.VideoCopyable)

	out := filepath.Join(dir, "hls")
	require.NoError(t, os.MkdirAll(out, 0o755))
	require.NoError(t, Remux(context.Background(), src, out, probe))

	master, err := os.ReadFile(filepath.Join(out, "master.m3u8"))
	require.NoError(t, err)
	playlist := string(master)

	// Without this a player cannot tell what the variant holds until it has
	// already failed to append it.
	require.Contains(t, playlist, "CODECS=")
	require.Contains(t, playlist, "hvc1.")
	require.Contains(t, playlist, "mp4a.40.2")

	// The sample entry has to say hvc1 too, or Safari rejects the stream.
	init, err := os.ReadFile(filepath.Join(out, "init_1.mp4"))
	require.NoError(t, err)
	require.Contains(t, string(init), "hvc1")
	require.NotContains(t, string(init), "hev1")

	// The codec string must be one the browser API will actually accept.
	for _, line := range strings.Split(playlist, "\n") {
		if !strings.HasPrefix(line, "#EXT-X-STREAM-INF:") {
			continue
		}
		require.Regexp(t, `CODECS="hvc1\.[0-9A-C]+\.[0-9A-F]+\.[LH][0-9]+(\.[0-9A-F]{2})*,mp4a\.40\.2"`, line)
	}
}

// H.264 is labelled by ffmpeg already; the annotation must not touch it.
func TestRemuxLeavesH264LabellingAloneIntegration(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "src.mkv")
	cmd := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=2",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=2",
		"-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", src)
	output, err := cmd.CombinedOutput()
	require.NoError(t, err, string(output))

	probe, err := Probe(context.Background(), src)
	require.NoError(t, err)
	out := filepath.Join(dir, "hls")
	require.NoError(t, os.MkdirAll(out, 0o755))
	require.NoError(t, Remux(context.Background(), src, out, probe))

	master, err := os.ReadFile(filepath.Join(out, "master.m3u8"))
	require.NoError(t, err)
	require.Contains(t, string(master), "avc1.")
	require.NotContains(t, string(master), "hvc1")
	// One CODECS attribute per variant, never two.
	require.Equal(t, strings.Count(string(master), "#EXT-X-STREAM-INF:"), strings.Count(string(master), "CODECS="))
}

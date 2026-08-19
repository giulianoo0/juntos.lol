//go:build integration

package media

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/room"
)

// makeLadderSource renders a 1080p clip with one audio track.
func makeLadderSource(t *testing.T, seconds int) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "source.mkv")
	output, err := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", fmt.Sprintf("testsrc=size=1920x1080:rate=24:duration=%d", seconds),
		"-f", "lavfi", "-i", fmt.Sprintf("sine=frequency=440:duration=%d", seconds),
		"-c:v", "libx264", "-preset", "veryfast", "-g", "48", "-b:v", "5M",
		"-c:a", "aac", "-shortest", path).CombinedOutput()
	require.NoError(t, err, string(output))
	return path
}

// TestRenditionLadderProducesAPlayableMultiQualityStream runs the real ffmpeg
// command the pipeline builds and checks the result is something a player can
// actually switch between, rather than only that the arguments look right.
func TestRenditionLadderProducesAPlayableMultiQualityStream(t *testing.T) {
	for _, binary := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(binary); err != nil {
			t.Skipf("%s not installed", binary)
		}
	}

	const seconds = 60
	source := makeLadderSource(t, seconds)
	outDir := t.TempDir()
	probe := &ProbeResult{
		VideoCodec: "h264", VideoCopyable: true, VideoHeight: 1080,
		Audio: []room.TrackInfo{{Index: 0, Language: "jpn"}},
	}

	started := time.Now()
	output, err := exec.Command("ffmpeg", BuildRemuxArgs(source, outDir, probe)...).CombinedOutput()
	require.NoError(t, err, string(output))
	elapsed := time.Since(started)
	t.Logf("%ds of 1080p encoded to a 4-rung ladder in %.1fs (%.1fx real time)",
		seconds, elapsed.Seconds(), float64(seconds)/elapsed.Seconds())

	master, err := os.ReadFile(filepath.Join(outDir, "final_master.m3u8"))
	require.NoError(t, err)
	text := string(master)

	// Four video renditions, so a viewer on a poor link has somewhere to go
	// instead of stalling on the only one there is.
	require.Equal(t, 4, strings.Count(text, "#EXT-X-STREAM-INF"), text)
	for _, resolution := range []string{"x1080", "x720", "x480", "x360"} {
		require.Contains(t, text, resolution, "missing rendition %s", resolution)
	}
	// One audio group shared by all of them.
	require.Equal(t, 1, strings.Count(text, "#EXT-X-MEDIA:TYPE=AUDIO"), text)

	// ffmpeg numbers the outputs in var_stream_map order, and the audio
	// renditions come first, so the video rungs start at 1.
	const firstVideoVariant = 1
	for rung := range 4 {
		playlist := filepath.Join(outDir, fmt.Sprintf("stream_%d.m3u8", firstVideoVariant+rung))
		data, err := os.ReadFile(playlist)
		require.NoError(t, err, playlist)
		require.Contains(t, string(data), "#EXTINF", playlist)
	}

	// The lower rungs must actually be smaller, or they buy the viewer nothing.
	sizes := make([]int64, 4)
	for rung := range 4 {
		matches, err := filepath.Glob(
			filepath.Join(outDir, fmt.Sprintf("stream_%d_*.m4s", firstVideoVariant+rung)))
		require.NoError(t, err)
		for _, match := range matches {
			info, err := os.Stat(match)
			require.NoError(t, err)
			sizes[rung] += info.Size()
		}
	}
	t.Logf("rendition sizes: 1080p=%dKB 720p=%dKB 480p=%dKB 360p=%dKB",
		sizes[0]/1024, sizes[1]/1024, sizes[2]/1024, sizes[3]/1024)
	require.Greater(t, sizes[0], sizes[1], "1080p is not larger than 720p")
	require.Greater(t, sizes[1], sizes[2], "720p is not larger than 480p")
	require.Greater(t, sizes[2], sizes[3], "480p is not larger than 360p")
}

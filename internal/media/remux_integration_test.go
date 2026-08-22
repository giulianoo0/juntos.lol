//go:build integration

package media

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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

func TestRemuxIntegrationCopiesVP9(t *testing.T) {
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
		"-map", "0:v", "-map", "1:a",
		"-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8",
		"-c:a", "aac", "-shortest", src,
	)
	if output, err := gen.CombinedOutput(); err != nil {
		if strings.Contains(string(output), "Unknown encoder") {
			t.Skip("ffmpeg built without libvpx-vp9")
		}
		require.NoError(t, err, string(output))
	}

	p, err := Probe(t.Context(), src)
	require.NoError(t, err)
	require.Equal(t, "vp9", p.VideoCodec)
	// VP9 is served by copy like the other three; there is no transcode
	// fallback left for it to fall into.
	require.True(t, p.VideoCopyable)
	require.NoError(t, CheckVideoSupported(p))

	out := filepath.Join(dir, "hls")
	require.NoError(t, os.MkdirAll(out, 0o755))
	require.NoError(t, Remux(t.Context(), src, out, p))

	master, err := os.ReadFile(filepath.Join(out, "master.m3u8"))
	require.NoError(t, err)
	require.Contains(t, string(master), "EXT-X-STREAM-INF")
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
		inputDone <- streamGrowingFile(ctx, src, stdin, time.Millisecond, nil)
	}()

	// This test drives ffmpeg directly, with no publisher behind it, so what
	// it can check is what ffmpeg wrote: a master, a variant playlist, an init
	// segment and a media segment.
	require.Eventually(t, func() bool { return ffmpegWroteAPlayableSet(out) }, 10*time.Second, 50*time.Millisecond)
	cancel()
	_ = stdin.Close()
	_ = cmd.Wait()
	require.Error(t, <-inputDone)

	// One variant, sound included. A separate audio group would double what the
	// preview writes and uploads, and the source here has both streams.
	playlists, err := filepath.Glob(filepath.Join(out, "preview_stream_*.m3u8"))
	require.NoError(t, err)
	require.Len(t, playlists, 1)
	require.Equal(t, "preview_stream_0.m3u8", filepath.Base(playlists[0]))

	// ffmpeg leaves %v unexpanded in the init filename when it writes a single
	// variant, and a glob for preview_init_*.mp4 happily matches the literal
	// name it produces. Only the exact name proves a player can fetch it.
	require.FileExists(t, filepath.Join(out, "preview_init_0.mp4"))
	variant, err := os.ReadFile(playlists[0])
	require.NoError(t, err)
	require.Contains(t, string(variant), `#EXT-X-MAP:URI="preview_init_0.mp4"`)
	require.NotContains(t, string(variant), "%v")
	master, err := os.ReadFile(filepath.Join(out, "master.m3u8"))
	require.NoError(t, err)
	require.NotContains(t, string(master), "EXT-X-MEDIA:TYPE=AUDIO")
	require.Contains(t, string(master), "mp4a")
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

func TestProgressiveRemuxIntegrationDualAudio(t *testing.T) {
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
		"-f", "lavfi", "-i", "sine=frequency=880:duration=8",
		"-map", "0:v", "-map", "1:a", "-map", "2:a",
		"-metadata:s:a:0", "language=por", "-metadata:s:a:1", "language=jpn",
		"-c:v", "libx264", "-g", "10", "-keyint_min", "10", "-sc_threshold", "0",
		"-c:a", "aac", "-shortest", src,
	)
	output, err := gen.CombinedOutput()
	require.NoError(t, err, string(output))

	probe, err := Probe(t.Context(), src)
	require.NoError(t, err)
	require.Len(t, probe.Audio, 2)
	out := filepath.Join(dir, "hls")
	require.NoError(t, os.MkdirAll(out, 0o755))

	ctx, cancel := context.WithCancel(t.Context())
	cmd := exec.CommandContext(ctx, "ffmpeg", BuildProgressiveRemuxArgs("pipe:0", out, probe)...)
	stdin, err := cmd.StdinPipe()
	require.NoError(t, err)
	require.NoError(t, cmd.Start())
	inputDone := make(chan error, 1)
	go func() {
		inputDone <- streamGrowingFile(ctx, src, stdin, time.Millisecond, nil)
	}()

	require.Eventually(t, func() bool { return ffmpegWroteAPlayableSet(out) }, 10*time.Second, 50*time.Millisecond)
	cancel()
	_ = stdin.Close()
	_ = cmd.Wait()
	require.Error(t, <-inputDone)

	// The point of the whole change: a viewer can switch dubs while the room is
	// still on the preview, instead of waiting out the final encode.
	master, err := os.ReadFile(filepath.Join(out, "master.m3u8"))
	require.NoError(t, err)
	require.Contains(t, string(master), "TYPE=AUDIO")
	require.Contains(t, string(master), `LANGUAGE="por"`)
	require.Contains(t, string(master), `LANGUAGE="jpn"`)
	require.Contains(t, string(master), `AUDIO="group_audio"`)

	// Two dubs and one video rendition, each its own stream of segments.
	playlists, err := filepath.Glob(filepath.Join(out, "preview_stream_*.m3u8"))
	require.NoError(t, err)
	require.Len(t, playlists, 3)

	// What previewPlayable will inspect has to be the variant ffmpeg actually
	// filled with video. Asking a dub instead announces the room while the
	// video is still empty.
	videoVariant := previewVideoVariantPlaylist(probe)
	require.Equal(t, "preview_stream_2.m3u8", videoVariant)
	require.Contains(t, string(master), videoVariant)
	variant, err := os.ReadFile(filepath.Join(out, videoVariant))
	require.NoError(t, err)
	require.Contains(t, string(variant), "#EXTINF")
	require.Contains(t, string(variant), `#EXT-X-MAP:URI="preview_init_2.mp4"`)

	// Several variants, so ffmpeg expands %v itself and the init names are real.
	require.NotContains(t, string(variant), "%v")
	require.FileExists(t, filepath.Join(out, "preview_init_2.mp4"))
}

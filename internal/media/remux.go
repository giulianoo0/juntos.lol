package media

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

const ffmpegErrorTailBytes = 2 * 1024

// BuildRemuxArgs builds the ffmpeg arguments for an HLS fMP4 output.
func BuildRemuxArgs(in, outDir string, p *ProbeResult) []string {
	return buildRemuxArgs(in, outDir, p, false)
}

// BuildProgressiveRemuxArgs builds the ffmpeg arguments for an HLS fMP4 output
// fed from a still-growing upload. The blocking stdin feed consumes bytes as
// soon as they arrive, and the event playlist grows until the final remux
// replaces it.
func BuildProgressiveRemuxArgs(in, outDir string, p *ProbeResult) []string {
	return buildRemuxArgs(in, outDir, p, true)
}

func buildRemuxArgs(in, outDir string, p *ProbeResult, progressive bool) []string {
	args := []string{"-hide_banner", "-loglevel", "error", "-y"}
	args = append(args, "-i", in, "-map", "0:v:0")

	mapping, streamMap := buildStreamMapping(p, progressive)
	args = append(args, mapping...)
	if progressive && !p.VideoCopyable {
		// Transcoded previews need a keyframe at each short segment boundary;
		// otherwise ffmpeg waits for libx264's much longer default GOP before
		// publishing the first playable segment.
		args = append(args, "-force_key_frames", "expr:gte(t,n_forced*2)")
	}

	playlistType := "vod"
	segmentTime := "6"
	segmentPattern := filepath.Join(outDir, "stream_%v_%03d.m4s")
	playlistPattern := filepath.Join(outDir, "stream_%v.m3u8")
	initName := "init_%v.mp4"
	masterName := "final_master.m3u8"
	if progressive {
		playlistType = "event"
		segmentTime = "2"
		// Keep preview files separate from the authoritative final remux. This
		// lets the final pass replace master.m3u8 without colliding with files
		// that a connected player may still have open.
		segmentPattern = filepath.Join(outDir, "preview_stream_%v_%06d.m4s")
		playlistPattern = filepath.Join(outDir, "preview_stream_%v.m3u8")
		initName = "preview_init_%v.mp4"
		masterName = "master.m3u8"
	}
	return append(args,
		"-f", "hls",
		"-hls_time", segmentTime,
		"-hls_segment_type", "fmp4",
		"-hls_fmp4_init_filename", initName,
		"-hls_playlist_type", playlistType,
		"-hls_flags", "independent_segments+temp_file",
		"-hls_segment_filename", segmentPattern,
		"-var_stream_map", streamMap,
		"-master_pl_name", masterName,
		playlistPattern,
	)
}

// buildStreamMapping returns the -map/-c arguments and the -var_stream_map
// value shared by the vod and progressive remux builders.
func buildStreamMapping(p *ProbeResult, progressive bool) (args []string, streamMap string) {
	if p.VideoCopyable {
		args = append(args, "-c:v", "copy")
		if p.VideoCodec == "hevc" {
			// ffmpeg labels a copied HEVC track hev1, which Safari's HLS stack
			// refuses. hvc1 is the same bitstream with its parameter sets in
			// the sample description instead of in band.
			args = append(args, "-tag:v", "hvc1")
		}
	} else {
		preset := "veryfast"
		if progressive {
			// Favor startup latency for the temporary preview. The authoritative
			// final remux keeps the denser veryfast encode.
			preset = "ultrafast"
		}
		args = append(args, "-c:v", "libx264", "-preset", preset, "-crf", "23")
	}

	for _, track := range p.Audio {
		args = append(args, "-map", "0:a:"+strconv.Itoa(track.Index))
	}
	if len(p.Audio) > 0 {
		args = append(args, "-c:a", "aac", "-b:a", "192k")
	}

	streamMap = "v:0"
	if len(p.Audio) > 0 {
		variants := make([]string, 0, len(p.Audio)+1)
		for i, track := range p.Audio {
			variant := "a:" + strconv.Itoa(i) + ",agroup:audio"
			if i == 0 {
				variant += ",default:yes"
			}
			if isSafeLanguage(track.Language) {
				variant += ",language:" + track.Language
			}
			variants = append(variants, variant)
		}
		variants = append(variants, "v:0,agroup:audio")
		streamMap = strings.Join(variants, " ")
	}
	return args, streamMap
}

func isSafeLanguage(language string) bool {
	if language == "" || len(language) > 35 {
		return false
	}
	for _, char := range language {
		if (char >= 'a' && char <= 'z') ||
			(char >= 'A' && char <= 'Z') ||
			(char >= '0' && char <= '9') ||
			char == '-' || char == '_' {
			continue
		}
		return false
	}
	return true
}

// Remux runs ffmpeg and returns the tail of stderr if the command fails.
func Remux(ctx context.Context, in, outDir string, p *ProbeResult) error {
	cmd := exec.CommandContext(ctx, "ffmpeg", BuildRemuxArgs(in, outDir, p)...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		detail := stderrTail(stderr.Bytes(), ffmpegErrorTailBytes)
		if detail == "" {
			return fmt.Errorf("run ffmpeg: %w", err)
		}
		return fmt.Errorf("run ffmpeg: %w: %s", err, detail)
	}
	finalMaster := filepath.Join(outDir, "final_master.m3u8")
	if err := os.Rename(finalMaster, filepath.Join(outDir, "master.m3u8")); err != nil {
		return fmt.Errorf("publish final HLS master: %w", err)
	}
	// Best effort: an unlabelled playlist still plays wherever the codec is
	// supported, so a failure here must not fail the whole remux.
	if err := annotateHEVCMaster(outDir, "master.m3u8", "init_*.mp4", p); err != nil {
		slog.WarnContext(ctx, "annotate HLS codecs failed", "error", err)
	}
	return nil
}

func stderrTail(stderr []byte, limit int) string {
	if len(stderr) > limit {
		stderr = stderr[len(stderr)-limit:]
	}
	return strings.TrimSpace(string(stderr))
}

// cleanupProgressiveOutputs removes preview-only files after the final VOD
// master playlist has been written. Authoritative stream_* files are kept.
func cleanupProgressiveOutputs(hlsDir string) error {
	patterns := []string{
		"preview_init_*.mp4",
		"preview_stream_*.m3u8",
		"preview_stream_*.m4s",
		"preview_*.tmp",
	}
	var errs []error
	for _, pattern := range patterns {
		matches, err := filepath.Glob(filepath.Join(hlsDir, pattern))
		if err != nil {
			errs = append(errs, err)
			continue
		}
		for _, match := range matches {
			if err := os.Remove(match); err != nil && !errors.Is(err, os.ErrNotExist) {
				errs = append(errs, fmt.Errorf("remove progressive output %s: %w", match, err))
			}
		}
	}
	return errors.Join(errs...)
}

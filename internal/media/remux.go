package media

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

const ffmpegErrorTailBytes = 2 * 1024

// BuildRemuxArgs builds the ffmpeg arguments for an HLS fMP4 output.
func BuildRemuxArgs(in, outDir string, p *ProbeResult) []string {
	args := []string{
		"-hide_banner", "-loglevel", "error",
		"-i", in,
		"-map", "0:v:0",
	}
	if p.VideoCopyable {
		args = append(args, "-c:v", "copy")
	} else {
		args = append(args, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23")
	}

	for _, track := range p.Audio {
		args = append(args, "-map", "0:a:"+strconv.Itoa(track.Index))
	}
	if len(p.Audio) > 0 {
		args = append(args, "-c:a", "aac", "-b:a", "192k")
	}

	streamMap := "v:0"
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

	return append(args,
		"-f", "hls",
		"-hls_time", "6",
		"-hls_segment_type", "fmp4",
		"-hls_playlist_type", "vod",
		"-hls_segment_filename", filepath.Join(outDir, "stream_%v_%03d.m4s"),
		"-var_stream_map", streamMap,
		"-master_pl_name", "master.m3u8",
		filepath.Join(outDir, "stream_%v.m3u8"),
	)
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
	return nil
}

func stderrTail(stderr []byte, limit int) string {
	if len(stderr) > limit {
		stderr = stderr[len(stderr)-limit:]
	}
	return strings.TrimSpace(string(stderr))
}

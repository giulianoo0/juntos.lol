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

	"github.com/giulianoo0/ss/internal/room"
)

// ExtractSubtitles converts every text subtitle track to an individual WebVTT file.
func ExtractSubtitles(ctx context.Context, in, outDir string, p *ProbeResult) ([]string, error) {
	return extractSubtitles(ctx, "ffmpeg", in, outDir, p)
}

func extractSubtitles(ctx context.Context, binary, in, outDir string, p *ProbeResult) ([]string, error) {
	if len(p.Subtitles) == 0 {
		return nil, nil
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return nil, fmt.Errorf("create subtitle directory: %w", err)
	}

	paths := make([]string, 0, len(p.Subtitles))
	for position, track := range p.Subtitles {
		args, output := buildSubtitleCommand(in, outDir, position, track)
		cmd := exec.CommandContext(ctx, binary, args...)
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		if err := cmd.Run(); err != nil {
			removeErr := removePartialSubtitle(output)
			if ctxErr := ctx.Err(); ctxErr != nil {
				cancelErr := fmt.Errorf("extract subtitles: %w", ctxErr)
				if removeErr != nil {
					return paths, errors.Join(cancelErr, removeErr)
				}
				return paths, cancelErr
			}
			var exitErr *exec.ExitError
			if !errors.As(err, &exitErr) {
				startErr := fmt.Errorf("start ffmpeg: %w", err)
				if removeErr != nil {
					return paths, errors.Join(startErr, removeErr)
				}
				return paths, startErr
			}
			slog.WarnContext(ctx, "subtitle extraction failed",
				"track_index", track.Index,
				"error", err,
				"stderr", stderrTail(stderr.Bytes(), ffmpegErrorTailBytes),
			)
			if removeErr != nil {
				slog.WarnContext(ctx, "remove partial subtitle failed", "error", removeErr)
			}
			continue
		}
		paths = append(paths, output)
	}

	return paths, nil
}

func removePartialSubtitle(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove partial subtitle %q: %w", path, err)
	}
	return nil
}

func buildSubtitleCommand(in, outDir string, position int, track room.TrackInfo) ([]string, string) {
	language := track.Language
	if !isSafeLanguage(language) {
		language = "und"
	}
	output := filepath.Join(outDir, "sub_"+strconv.Itoa(position)+"_"+language+".vtt")
	args := []string{
		"-hide_banner", "-loglevel", "error", "-y",
		"-i", in,
		"-map", "0:s:" + strconv.Itoa(track.Index),
		"-c:s", "webvtt",
		output,
	}
	return args, output
}

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
		if isStyledSubtitle(output) {
			converted, err := convertStyledSubtitle(output)
			if err != nil {
				slog.WarnContext(ctx, "styled subtitle conversion failed",
					"track_index", track.Index, "error", err)
				continue
			}
			output = converted
		} else if err := positionSubtitleFile(output); err != nil {
			slog.WarnContext(ctx, "position subtitle failed",
				"track_index", track.Index, "error", err)
		}
		paths = append(paths, output)
	}

	return paths, nil
}

// styledSubtitleCodecs are the script formats whose placement and color the
// conversion keeps. ffmpeg's webvtt encoder drops both, so these tracks are
// extracted as ASS and converted by this package instead.
var styledSubtitleCodecs = map[string]struct{}{"ass": {}, "ssa": {}}

func isStyledSubtitle(path string) bool {
	return strings.EqualFold(filepath.Ext(path), ".ass")
}

// convertStyledSubtitle rewrites an extracted ASS script as the WebVTT file
// the room publishes, and removes the script so nothing else picks it up.
func convertStyledSubtitle(assPath string) (string, error) {
	data, err := os.ReadFile(assPath)
	removeErr := os.Remove(assPath)
	if err != nil {
		return "", errors.Join(fmt.Errorf("read extracted subtitle: %w", err), removeErr)
	}
	vtt := ConvertASSToVTT(data)
	if len(vtt) == 0 {
		return "", errors.Join(fmt.Errorf("subtitle script %q holds no renderable cue", filepath.Base(assPath)), removeErr)
	}
	vttPath := strings.TrimSuffix(assPath, filepath.Ext(assPath)) + ".vtt"
	if err := os.WriteFile(vttPath, vtt, 0o644); err != nil {
		return "", errors.Join(fmt.Errorf("write converted subtitle: %w", err), removeErr)
	}
	return vttPath, removeErr
}

// positionSubtitleFile rewrites a converted WebVTT file with its dialogue
// cues positioned. Best effort: an unpositioned track still renders.
func positionSubtitleFile(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read subtitle: %w", err)
	}
	if err := os.WriteFile(path, positionDialogueCues(data), 0o644); err != nil {
		return fmt.Errorf("write positioned subtitle: %w", err)
	}
	return nil
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
	codec, extension := "webvtt", ".vtt"
	if _, styled := styledSubtitleCodecs[track.Codec]; styled {
		codec, extension = "ass", ".ass"
	}
	output := filepath.Join(outDir, "sub_"+strconv.Itoa(position)+"_"+language+extension)
	args := []string{
		"-hide_banner", "-loglevel", "error", "-y",
		"-i", in,
		"-map", "0:s:" + strconv.Itoa(track.Index),
		"-c:s", codec,
		output,
	}
	return args, output
}

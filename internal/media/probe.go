package media

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os/exec"
	"strconv"
	"strings"

	"github.com/giulianoo0/ss/internal/room"
)

var textSubtitleCodecs = map[string]struct{}{
	"ass":      {},
	"mov_text": {},
	"subrip":   {},
	"webvtt":   {},
}

var bitmapSubtitleCodecs = map[string]struct{}{
	"dvd_subtitle":      {},
	"hdmv_pgs_subtitle": {},
}

// ProbeResult describes the streams relevant to the media pipeline.
type ProbeResult struct {
	DurationMs    int64
	VideoCodec    string
	VideoCopyable bool
	Audio         []room.TrackInfo
	Subtitles     []room.TrackInfo
	BitmapSubs    int
}

type probeOutput struct {
	Streams []struct {
		CodecName string `json:"codec_name"`
		CodecType string `json:"codec_type"`
		Tags      struct {
			Language string `json:"language"`
			Title    string `json:"title"`
		} `json:"tags"`
	} `json:"streams"`
	Format struct {
		Duration string `json:"duration"`
	} `json:"format"`
}

// Probe runs ffprobe and parses its JSON stream inventory.
func Probe(ctx context.Context, path string) (*ProbeResult, error) {
	cmd := exec.CommandContext(ctx, "ffprobe",
		"-v", "error",
		"-print_format", "json",
		"-show_format",
		"-show_streams",
		path,
	)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	data, err := cmd.Output()
	if err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			return nil, fmt.Errorf("run ffprobe: %w", err)
		}
		return nil, fmt.Errorf("run ffprobe: %w: %s", err, detail)
	}

	result, err := parseProbe(data)
	if err != nil {
		return nil, fmt.Errorf("parse ffprobe output: %w", err)
	}
	return result, nil
}

func parseProbe(data []byte) (*ProbeResult, error) {
	var raw probeOutput
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("decode JSON: %w", err)
	}

	result := &ProbeResult{}
	// Partial uploads often lack format.duration; only a present value must parse.
	if raw.Format.Duration != "" {
		durationSeconds, err := strconv.ParseFloat(raw.Format.Duration, 64)
		if err != nil {
			return nil, fmt.Errorf("parse duration %q: %w", raw.Format.Duration, err)
		}
		result.DurationMs = int64(math.Round(durationSeconds * 1000))
	}
	audioIndex := 0
	subtitleIndex := 0
	for _, stream := range raw.Streams {
		switch stream.CodecType {
		case "video":
			if result.VideoCodec == "" {
				result.VideoCodec = stream.CodecName
				result.VideoCopyable = stream.CodecName == "h264" || stream.CodecName == "hevc"
			}
		case "audio":
			result.Audio = append(result.Audio, room.TrackInfo{
				Index:    audioIndex,
				Language: stream.Tags.Language,
				Title:    stream.Tags.Title,
				Codec:    stream.CodecName,
			})
			audioIndex++
		case "subtitle":
			if _, ok := textSubtitleCodecs[stream.CodecName]; ok {
				result.Subtitles = append(result.Subtitles, room.TrackInfo{
					Index:    subtitleIndex,
					Language: stream.Tags.Language,
					Title:    stream.Tags.Title,
					Codec:    stream.CodecName,
				})
			} else if _, ok := bitmapSubtitleCodecs[stream.CodecName]; ok {
				result.BitmapSubs++
			}
			subtitleIndex++
		}
	}

	return result, nil
}

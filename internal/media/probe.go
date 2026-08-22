package media

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os/exec"
	"slices"
	"strconv"
	"strings"

	"github.com/giulianoo0/ss/internal/room"
)

const (
	// maxChapters bounds how many chapter atoms are trusted from one file.
	maxChapters = 512
	// maxChapterTitleBytes bounds a single chapter title.
	maxChapterTitleBytes = 200
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
	// VideoHeight is the source's own height, which bounds the rendition
	// ladder: offering a size the source never had is upscaling, and costs
	// bandwidth to deliver a blurrier picture.
	VideoHeight int
	Audio       []room.TrackInfo
	Subtitles   []room.TrackInfo
	// Chapters are the source's authored spans (openings, recaps), in play
	// order as the container declares them.
	Chapters   []room.Chapter
	BitmapSubs int
}

type probeOutput struct {
	Streams []struct {
		CodecName string `json:"codec_name"`
		CodecType string `json:"codec_type"`
		Width     int    `json:"width"`
		Height    int    `json:"height"`
		Tags      struct {
			Language string `json:"language"`
			Title    string `json:"title"`
		} `json:"tags"`
		Disposition struct {
			AttachedPic int `json:"attached_pic"`
		} `json:"disposition"`
	} `json:"streams"`
	Chapters []struct {
		StartTime string `json:"start_time"`
		EndTime   string `json:"end_time"`
		Tags      struct {
			Title string `json:"title"`
		} `json:"tags"`
	} `json:"chapters"`
	Format struct {
		Duration string `json:"duration"`
	} `json:"format"`
}

// ErrUnsupportedVideo marks a source whose video the pipeline refuses to
// serve. Nothing is transcoded any more, so a codec outside the copyable set
// can never become playable media — the room is killed instead of spending a
// download and an encode on a file that ends as a black screen.
var ErrUnsupportedVideo = errors.New("unsupported video codec")

// PublicUnsupportedVideo is the user-visible verdict for those rooms. It
// names the actual problem: "processing failed" would send whoever hit it off
// to retry a file that can never work.
const PublicUnsupportedVideo = "this video format is not supported"

// CheckVideoSupported reports whether the probed source is one the pipeline
// will serve: video in the copyable set, since copy is all it does now.
func CheckVideoSupported(p *ProbeResult) error {
	if p == nil || p.VideoCodec == "" {
		return fmt.Errorf("%w: no video track", ErrUnsupportedVideo)
	}
	if !p.VideoCopyable {
		return fmt.Errorf("%w: %s", ErrUnsupportedVideo, p.VideoCodec)
	}
	return nil
}

// Probe runs ffprobe and parses its JSON stream inventory.
func Probe(ctx context.Context, path string) (*ProbeResult, error) {
	cmd := exec.CommandContext(ctx, "ffprobe",
		"-v", "error",
		"-print_format", "json",
		"-show_format",
		"-show_streams",
		"-show_chapters",
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
	for _, chapter := range raw.Chapters {
		start, startErr := strconv.ParseFloat(chapter.StartTime, 64)
		end, endErr := strconv.ParseFloat(chapter.EndTime, 64)
		// A chapter whose times do not parse, or that spans nothing, is noise
		// from a broken muxer: better no marker than one pointing nowhere.
		if startErr != nil || endErr != nil || end <= start {
			continue
		}
		title := chapter.Tags.Title
		if len(title) > maxChapterTitleBytes {
			title = strings.ToValidUTF8(title[:maxChapterTitleBytes], "")
		}
		result.Chapters = append(result.Chapters, room.Chapter{
			StartMs: int64(math.Round(start * 1000)),
			EndMs:   int64(math.Round(end * 1000)),
			Title:   title,
		})
		// The list rides in one Redis hash field and in every room GET; a
		// broken muxer with thousands of chapter atoms must not bloat both.
		if len(result.Chapters) == maxChapters {
			break
		}
	}
	// Play order, whatever order the container declared them in: the player
	// numbers unnamed chapters by position.
	slices.SortStableFunc(result.Chapters, func(a, b room.Chapter) int {
		return cmp.Compare(a.StartMs, b.StartMs)
	})
	audioIndex := 0
	subtitleIndex := 0
	for _, stream := range raw.Streams {
		switch stream.CodecType {
		case "video":
			// Embedded cover art is a video stream by codec type and nothing
			// else. Reading it as "the video" would refuse a playable file —
			// and the refusal path deletes the room.
			if stream.Disposition.AttachedPic != 0 {
				continue
			}
			if result.VideoCodec == "" {
				result.VideoCodec = stream.CodecName
				// Everything here packs into fMP4 and is decoded natively by
				// the browsers that reach this pipeline, so the encode is a
				// remux. There is no transcode fallback: a codec outside this
				// set is refused outright (see CheckVideoSupported), because
				// transcoding cost a room roughly its own running time in CPU.
				result.VideoCopyable = stream.CodecName == "h264" ||
					stream.CodecName == "hevc" || stream.CodecName == "av1" ||
					stream.CodecName == "vp9"
				result.VideoHeight = stream.Height
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

package media

import (
	"fmt"
	"strconv"
	"strings"
)

// MaxDeliveredHeight caps what the server will ever hand a viewer. A 1440p or
// 4K source is re-encoded down to this rather than copied: delivering it costs
// the VPS far more bandwidth than the picture is worth on a watch party, and
// nobody in the room asked for a master copy.
const MaxDeliveredHeight = 1080

// ladderHeights are the sizes offered below the top one, largest first. A
// source never gets a rendition it cannot fill: upscaling spends CPU and
// bandwidth to deliver a blurrier picture than the one already there.
var ladderHeights = []int{720, 480, 360}

// videoBitrates is the target for each height, in kbit/s. They are deliberately
// conservative — the point of the lower rungs is to keep playing on a link that
// cannot sustain the top one.
var videoBitrates = map[int]int{
	1080: 4500,
	720:  2500,
	480:  1200,
	360:  700,
}

// Rendition is one video variant of the published stream.
type Rendition struct {
	// Height is the vertical size, 0 when the source size is unknown and the
	// track is passed through untouched.
	Height int
	// Copy passes the source video through without re-encoding. Only ever set
	// on the top rendition, and only when the source is already within
	// MaxDeliveredHeight.
	Copy bool
	// BitrateKbps is the encoding target; 0 for a copied rendition.
	BitrateKbps int
}

// RenditionLadder decides what to publish for a source.
//
// The top rung is the source itself when it is small enough to pass through,
// and a re-encode down to MaxDeliveredHeight when it is not. Below it come the
// standard sizes the source can actually fill. A source whose height could not
// be probed gets a single pass-through, which is what the pipeline always did.
func RenditionLadder(p *ProbeResult) []Rendition {
	// Without a height there is nothing to scale against, so the source is
	// passed through as it always was: one rendition, no ladder. Guessing a
	// size here would either upscale or crop.
	if p == nil || p.VideoHeight <= 0 {
		return []Rendition{{Copy: p == nil || p.VideoCopyable}}
	}

	var ladder []Rendition
	top := p.VideoHeight
	if top > MaxDeliveredHeight {
		// Too big to hand over as-is, so the top rung is an encode.
		top = MaxDeliveredHeight
		ladder = append(ladder, Rendition{Height: top, BitrateKbps: videoBitrates[top]})
	} else {
		ladder = append(ladder, Rendition{Height: top, Copy: p.VideoCopyable, BitrateKbps: bitrateFor(top)})
	}

	for _, height := range ladderHeights {
		if height >= top {
			continue
		}
		ladder = append(ladder, Rendition{Height: height, BitrateKbps: videoBitrates[height]})
	}
	return ladder
}

// bitrateFor picks the encoding target for a height that is not one of the
// ladder's own, which happens when a source sits between two rungs.
func bitrateFor(height int) int {
	best := videoBitrates[1080]
	for _, rung := range []int{360, 480, 720, 1080} {
		if height <= rung {
			return videoBitrates[rung]
		}
	}
	return best
}

// buildVideoRenditionArgs renders the filter graph and per-variant encoding
// options for a ladder, plus the v: entries of the stream map.
//
// Every scaled rendition is fed by one split of a single decode: decoding a
// 1080p source once and scaling it three ways costs far less than three
// independent passes over the same file.
func buildVideoRenditionArgs(ladder []Rendition, p *ProbeResult, progressive bool) (args []string, videoMap []string) {
	// Only renditions with a target height go through the filter graph. One
	// without a height is an unscaled transcode of a source whose size we
	// never learned.
	scaled := make([]Rendition, 0, len(ladder))
	for _, rendition := range ladder {
		if !rendition.Copy && rendition.Height > 0 {
			scaled = append(scaled, rendition)
		}
	}

	if len(scaled) > 0 {
		var graph strings.Builder
		// split=1 is legal and keeps the label naming uniform.
		graph.WriteString("[0:v]split=" + strconv.Itoa(len(scaled)))
		for index := range scaled {
			fmt.Fprintf(&graph, "[s%d]", index)
		}
		for index, rendition := range scaled {
			// -2 keeps the source aspect ratio and rounds the width to an even
			// number, which H.264 requires.
			fmt.Fprintf(&graph, ";[s%d]scale=-2:%d[v%d]", index, rendition.Height, index)
		}
		args = append(args, "-filter_complex", graph.String())
	}

	preset := "veryfast"
	if progressive {
		preset = "ultrafast"
	}

	scaledIndex := 0
	for position, rendition := range ladder {
		variant := strconv.Itoa(position)
		if rendition.Copy {
			args = append(args, "-map", "0:v:0", "-c:v:"+variant, "copy")
			if p.VideoCodec == "hevc" {
				// ffmpeg labels a copied HEVC track hev1, which Safari's HLS
				// stack refuses. hvc1 is the same bitstream with its parameter
				// sets in the sample description instead of in band.
				args = append(args, "-tag:v:"+variant, "hvc1")
			}
			videoMap = append(videoMap, "v:"+variant)
			continue
		}
		if rendition.Height <= 0 {
			// Unknown source size: re-encode at whatever it is, quality-targeted
			// rather than bitrate-targeted, because there is no rung to hit.
			args = append(args,
				"-map", "0:v:0",
				"-c:v:"+variant, "libx264",
				"-preset:v:"+variant, preset,
				"-crf:v:"+variant, "23",
			)
			videoMap = append(videoMap, "v:"+variant)
			continue
		}
		bitrate := strconv.Itoa(rendition.BitrateKbps) + "k"
		args = append(args,
			"-map", fmt.Sprintf("[v%d]", scaledIndex),
			"-c:v:"+variant, "libx264",
			"-preset:v:"+variant, preset,
			"-b:v:"+variant, bitrate,
			// A ceiling and a matching buffer keep a busy scene from spiking
			// past what the rung promises, which is the whole point of having
			// rungs: a variant that overshoots strands the viewer it was for.
			"-maxrate:v:"+variant, strconv.Itoa(rendition.BitrateKbps*115/100)+"k",
			"-bufsize:v:"+variant, strconv.Itoa(rendition.BitrateKbps*2)+"k",
		)
		scaledIndex++
		videoMap = append(videoMap, "v:"+variant)
	}
	return args, videoMap
}

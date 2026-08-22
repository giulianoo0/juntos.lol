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

// previewSegmentSeconds is how long one preview segment runs.
//
// Every segment is a separate object in the bucket, and a write there is the
// unit the storage bills and the unit the upload pays a round trip for, so the
// length of a preview segment sets what a whole movie costs to publish twice.
// It is still short enough that a viewer waits for a fraction of a segment
// before the room plays, which is what the preview exists for.
const previewSegmentSeconds = "4"

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
	args = append(args, "-i", in)

	mapping, streamMap := buildStreamMapping(p, progressive)
	args = append(args, mapping...)
	if progressive && !p.VideoCopyable {
		// Transcoded previews need a keyframe at each short segment boundary;
		// otherwise ffmpeg waits for libx264's much longer default GOP before
		// publishing the first playable segment.
		args = append(args, "-force_key_frames",
			"expr:gte(t,n_forced*"+previewSegmentSeconds+")")
	}

	// Both passes grow their playlist as they encode. A vod playlist is only
	// written once ffmpeg finishes, which leaves everything it produced
	// unpublishable until then: the room stays pinned to whatever the preview
	// reached, and for a source that arrived all at once that is seconds.
	playlistType := "event"
	segmentTime := "6"
	segmentPattern := filepath.Join(outDir, "stream_%v_%03d.m4s")
	playlistPattern := filepath.Join(outDir, "stream_%v.m3u8")
	initName := "init_%v.mp4"
	masterName := "final_master.m3u8"
	if progressive {
		segmentTime = previewSegmentSeconds
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
		"-hls_fmp4_init_filename", initSegmentName(initName, streamMap),
		"-hls_playlist_type", playlistType,
		"-hls_flags", "independent_segments+temp_file",
		"-hls_segment_filename", segmentPattern,
		"-var_stream_map", streamMap,
		"-master_pl_name", masterName,
		playlistPattern,
	)
}

// initSegmentName resolves the %v in an init filename that ffmpeg will not
// resolve itself.
//
// ffmpeg expands %v in the segment filename and the playlist name always, but
// in the init filename only when the output carries more than one variant.
// With a single one it writes a file called literally "init_%v.mp4" and points
// EXT-X-MAP at that name, which no player can fetch — the room then loads
// forever rather than failing outright, because a missing init segment is
// indistinguishable from one that has not been written yet.
func initSegmentName(pattern, streamMap string) string {
	if len(strings.Fields(streamMap)) > 1 {
		return pattern
	}
	return strings.Replace(pattern, "%v", "0", 1)
}

// buildStreamMapping returns the -map/-c arguments and the -var_stream_map
// value shared by the vod and progressive remux builders.
func buildStreamMapping(p *ProbeResult, progressive bool) (args []string, streamMap string) {
	// The preview stays a single pass-through rendition. It exists to make a
	// room playable seconds after the first megabyte, and encoding anything
	// there would spend that head start; the ladder arrives with the final
	// remux, which is what viewers settle on.
	ladder := []Rendition{{Copy: p.VideoCopyable, Height: p.VideoHeight}}
	if !progressive {
		ladder = RenditionLadder(p)
	}
	videoArgs, videoMap := buildVideoRenditionArgs(ladder, p, progressive)
	args = append(args, videoArgs...)

	audio := p.Audio
	for _, track := range audio {
		args = append(args, "-map", "0:a:"+strconv.Itoa(track.Index))
	}
	if len(audio) > 0 {
		args = append(args, "-c:a", "aac", "-b:a", "192k")
	}

	if len(audio) == 0 {
		streamMap = strings.Join(videoMap, " ")
		return args, streamMap
	}

	// With a single dub the preview muxes its audio into its one video variant
	// instead of giving it a group of its own. A group is a second stream of
	// segments, so it costs the preview another write to disk and another
	// upload to the bucket, and with nothing to switch to it buys nothing.
	//
	// More than one dub is the opposite case: the switch is the whole point,
	// and leaving it to the final ladder leaves it out for the length of the
	// encode — tens of minutes on a feature. So the preview pays for the group
	// exactly when a viewer has something to choose between.
	if progressive && len(audio) == 1 {
		return args, videoMap[0] + ",a:0"
	}

	variants := make([]string, 0, len(audio)+len(videoMap))
	for i, track := range audio {
		variant := "a:" + strconv.Itoa(i) + ",agroup:audio"
		if i == 0 {
			variant += ",default:yes"
		}
		if isSafeLanguage(track.Language) {
			variant += ",language:" + track.Language
		}
		variants = append(variants, variant)
	}
	// Every video rendition points at the same audio group, so switching
	// picture quality never reopens the audio the viewer chose.
	for _, video := range videoMap {
		variants = append(variants, video+",agroup:audio")
	}
	return args, strings.Join(variants, " ")
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
	// Annotate before publishing so a viewer can never fetch a master carrying
	// ffmpeg's own HEVC codec string, which some releases render invalidly.
	// Best effort: an unlabelled playlist still plays wherever the codec is
	// supported, so a failure here must not fail the whole remux.
	if err := annotateHEVCMaster(outDir, "final_master.m3u8", "init_*.mp4", p); err != nil {
		slog.WarnContext(ctx, "annotate HLS codecs failed", "error", err)
	}
	finalMaster := filepath.Join(outDir, "final_master.m3u8")
	if err := os.Rename(finalMaster, filepath.Join(outDir, "master.m3u8")); err != nil {
		return fmt.Errorf("publish final HLS master: %w", err)
	}
	return nil
}

func stderrTail(stderr []byte, limit int) string {
	if len(stderr) > limit {
		stderr = stderr[len(stderr)-limit:]
	}
	return strings.TrimSpace(string(stderr))
}

// finalizeProgressiveOutputs closes every preview EVENT playlist after the
// final VOD master replaces the preview master.
//
// The preview files themselves are deliberately kept: a player that joined
// during the preview still holds those playlists and may be mid-fetch of a
// segment, so deleting them would 404 a connected viewer. They are reclaimed
// with the room directory on source swap or expiry. Appending EXT-X-ENDLIST
// turns the canceled remux's never-growing event playlist into a finished one,
// so any straggler plays out what exists and stops polling instead of waiting
// forever for a segment that will never arrive.
func finalizeProgressiveOutputs(hlsDir string) error {
	var errs []error
	tmps, err := filepath.Glob(filepath.Join(hlsDir, "preview_*.tmp"))
	if err != nil {
		errs = append(errs, err)
	}
	for _, match := range tmps {
		// Temp files of the killed preview remux are referenced by nothing.
		if err := os.Remove(match); err != nil && !errors.Is(err, os.ErrNotExist) {
			errs = append(errs, fmt.Errorf("remove progressive temp file %s: %w", match, err))
		}
	}
	playlists, err := filepath.Glob(filepath.Join(hlsDir, "preview_stream_*.m3u8"))
	if err != nil {
		errs = append(errs, err)
	}
	for _, playlist := range playlists {
		if err := endEventPlaylist(playlist); err != nil {
			errs = append(errs, fmt.Errorf("finalize preview playlist %s: %w", playlist, err))
		}
	}
	return errors.Join(errs...)
}

// endEventPlaylist appends EXT-X-ENDLIST via a whole-file replace, so a player
// polling the playlist sees either the old version or the finished one.
func endEventPlaylist(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if bytes.Contains(data, []byte("#EXT-X-ENDLIST")) {
		return nil
	}
	if len(data) > 0 && data[len(data)-1] != '\n' {
		data = append(data, '\n')
	}
	data = append(data, []byte("#EXT-X-ENDLIST\n")...)
	temp := path + ".end"
	if err := os.WriteFile(temp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(temp, path)
}

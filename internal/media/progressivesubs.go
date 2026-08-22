package media

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/giulianoo0/ss/internal/room"
)

const (
	// subtitleSnapshotInterval is how soon the cues extracted so far are first
	// republished while bytes keep arriving.
	subtitleSnapshotInterval = 6 * time.Second
	// maxSubtitleSnapshotInterval is how far apart snapshots grow to be.
	maxSubtitleSnapshotInterval = 60 * time.Second
	// cueMarker is what makes a WebVTT file worth publishing: a header alone
	// gives a viewer an empty track and a subtitle menu that promises nothing.
	cueMarker = "-->"
	// subtitleWrapUpTimeout bounds the one publish that outlives its job.
	subtitleWrapUpTimeout = 30 * time.Second
)

// buildProgressiveSubtitleArgs extracts every text subtitle track of a growing
// input to its own WebVTT file.
//
// -flush_packets is what makes this progressive at all: without it ffmpeg
// buffers cues and the file on disk stays empty for minutes at a time, which
// is indistinguishable from a track that is not coming.
func buildProgressiveSubtitleArgs(in, subsDir string, p *ProbeResult) ([]string, []string) {
	args := []string{"-hide_banner", "-loglevel", "error", "-y", "-flush_packets", "1", "-i", in}
	outputs := make([]string, 0, len(p.Subtitles))
	for position, track := range p.Subtitles {
		name := publishedSubtitleName(position, track.Language)
		codec := "webvtt"
		// Every track grows as a work file the snapshot converts into the
		// published .vtt: a styled one as the script whose placement and color
		// the conversion keeps, a plain one so its dialogue can be positioned.
		if _, styled := styledSubtitleCodecs[track.Codec]; styled {
			codec = "ass"
			name = strings.TrimSuffix(name, ".vtt") + ".ass"
		} else {
			name += ".src"
		}
		output := filepath.Join(subsDir, name)
		args = append(args,
			"-map", "0:s:"+strconv.Itoa(track.Index),
			"-c:s", codec,
			"-flush_packets", "1",
			// The work extension is not a name ffmpeg picks a muxer from.
			"-f", codec,
			output)
		outputs = append(outputs, output)
	}
	return args, outputs
}

// extractSubtitles publishes the subtitles muxed into a still-arriving source,
// as they are decoded rather than once the download ends.
//
// It runs as its own ffmpeg pass over the same growing file rather than as
// extra outputs on the preview remux. That reads a little more from disk, and
// buys the guarantee that a subtitle track ffmpeg cannot handle costs the room
// its subtitles and never its video.
func (p *Progressive) extractSubtitles(ctx, jobCtx context.Context, job progressiveJob, probe *ProbeResult) {
	if len(probe.Subtitles) == 0 {
		return
	}
	// A client that already extracted them is authoritative; doing it again
	// would publish the same tracks twice under different numbering.
	if clientSubs, err := p.store.HasClientSubs(jobCtx, job.roomID); err != nil || clientSubs {
		return
	}
	// The generation this extraction reads. The wrap-up publish compares it
	// against the room again, because the job context it outlives dies for two
	// reasons it must tell apart: the source finishing, and the source being
	// replaced.
	stored, err := p.store.Get(jobCtx, job.roomID)
	if err != nil {
		slog.WarnContext(ctx, "progressive subs: read room failed", "room_id", job.roomID, "error", err)
		return
	}
	generation := stored.MediaGeneration

	subsDir := filepath.Join(p.dataDir, "rooms", job.roomID, "subs")
	if err := os.MkdirAll(subsDir, 0o755); err != nil {
		slog.WarnContext(ctx, "progressive subs: create directory failed",
			"room_id", job.roomID, "error", err)
		return
	}

	args, outputs := buildProgressiveSubtitleArgs("pipe:0", subsDir, probe)
	cmd := exec.CommandContext(jobCtx, "ffmpeg", args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		slog.WarnContext(ctx, "progressive subs: create input failed", "room_id", job.roomID, "error", err)
		return
	}
	if err := cmd.Start(); err != nil {
		slog.WarnContext(ctx, "progressive subs: start ffmpeg failed", "room_id", job.roomID, "error", err)
		return
	}
	slog.InfoContext(ctx, "progressive subtitles starting",
		"room_id", job.roomID, "tracks", len(probe.Subtitles))

	inputCtx, stopInput := context.WithCancel(jobCtx)
	defer stopInput()
	go func() {
		err := streamGrowingFile(inputCtx, job.srcPath, stdin, inputPollInterval,
			func() bool { return p.isComplete(job.roomID) })
		if closeErr := stdin.Close(); err == nil {
			err = closeErr
		}
		if err != nil && jobCtx.Err() == nil && !errors.Is(err, io.ErrClosedPipe) {
			slog.WarnContext(ctx, "progressive subs: growing input stopped",
				"room_id", job.roomID, "error", err)
		}
	}()

	waitErr := make(chan error, 1)
	go func() { waitErr <- cmd.Wait() }()

	interval := nextSubtitleInterval(0)
	timer := time.NewTimer(interval)
	defer timer.Stop()
	var published subtitleSnapshot
	for {
		select {
		case <-waitErr:
			stopInput()
			_ = stdin.Close()
			// One last look: the final cues land between two snapshots more
			// often than not.
			p.wrapUpSubtitles(ctx, jobCtx, job.roomID, generation, probe, outputs, &published)
			return
		case <-jobCtx.Done():
			return
		case <-timer.C:
			p.publishSubtitleSnapshot(ctx, jobCtx, job.roomID, probe, outputs, &published)
			interval = nextSubtitleInterval(interval)
			timer.Reset(interval)
		}
	}
}

// nextSubtitleInterval widens the gap between snapshots as an extraction runs
// on.
//
// The first one matters most: until it lands the room has no subtitles at all.
// Every one after publishes cues further ahead of where anyone is watching, at
// the price of an upload per track and a republish that sends every connected
// player back for all of them. Nothing is lost at the end by spacing them out,
// because the wrap-up publish fires the moment the source stops arriving.
func nextSubtitleInterval(current time.Duration) time.Duration {
	if current <= 0 {
		return subtitleSnapshotInterval
	}
	return min(current*2, maxSubtitleSnapshotInterval)
}

// wrapUpSubtitles publishes the cues that arrived after the last tick.
//
// The job context is routinely already dead here: the final remux cancels the
// progressive job the moment the source finishes arriving, which is exactly
// when the last cues land on disk. Dying with it would hold the ending back
// until the final pass republishes everything, long after the room got there.
// So the publish detaches — bounded, and only for a room still on the source
// this extraction was reading, because the same cancellation also fires when
// the source is replaced and these cues describe a video nobody is watching.
func (p *Progressive) wrapUpSubtitles(ctx, jobCtx context.Context, roomID string, generation int,
	probe *ProbeResult, outputs []string, published *subtitleSnapshot) {
	wrapCtx, cancel := context.WithTimeout(context.WithoutCancel(jobCtx), subtitleWrapUpTimeout)
	defer cancel()
	stored, err := p.store.Get(wrapCtx, roomID)
	if err != nil || stored.MediaGeneration != generation {
		return
	}
	p.publishSubtitleSnapshot(ctx, wrapCtx, roomID, probe, outputs, published)
}

// subtitleSnapshot remembers what the last publish covered, so a tick that
// added nothing publishes nothing.
type subtitleSnapshot struct {
	tracks int
	bytes  int64
}

// publishSubtitleSnapshot announces the tracks that now hold at least one cue.
// It republishes when that set grows and when an already-published track gained
// cues: a player only refetches on a version bump, so a snapshot that stopped
// republishing would freeze every viewer at the cues of the first publish. The
// tick interval is what bounds how often connected players refetch.
func (p *Progressive) publishSubtitleSnapshot(ctx, jobCtx context.Context, roomID string,
	probe *ProbeResult, outputs []string, published *subtitleSnapshot) {
	tracks := make([]room.TrackInfo, 0, len(outputs))
	var totalBytes int64
	for position, output := range outputs {
		if !hasSubtitleCues(output) {
			continue
		}
		// Each snapshot rewrites the VTT the players fetch from the growing
		// work file, which stays — ffmpeg keeps appending to it.
		if !snapshotSubtitleWorkFile(output) {
			continue
		}
		if info, err := os.Stat(output); err == nil {
			totalBytes += info.Size()
		}
		track := probe.Subtitles[position]
		track.Index = position
		track.Codec = "webvtt"
		tracks = append(tracks, track)
	}
	if len(tracks) <= published.tracks && totalBytes <= published.bytes {
		return
	}
	// The files reach the bucket before the tracks are announced, so a client
	// that refetches on the version bump finds something to read. Uploading
	// here rather than every tick is deliberate: an unchanged version means no
	// client refetches, so a fresh copy would be paid for and never used.
	subsDir := filepath.Join(p.dataDir, "rooms", roomID, "subs")
	if err := p.publisher.PublishSubtitles(jobCtx, roomID, subsDir); err != nil {
		slog.WarnContext(ctx, "progressive subs: upload failed", "room_id", roomID, "error", err)
		return
	}
	// Incomplete on purpose: the authoritative pass over the finished file
	// still runs, and it is the one that gets every cue.
	if err := p.store.SetClientSubtitles(jobCtx, roomID, tracks, false); err != nil {
		slog.WarnContext(ctx, "progressive subs: publish failed", "room_id", roomID, "error", err)
		return
	}
	*published = subtitleSnapshot{tracks: len(tracks), bytes: totalBytes}
	slog.InfoContext(ctx, "progressive subtitles published", "room_id", roomID, "tracks", len(tracks))
	p.notifyUpdated(roomID)
}

// hasSubtitleCues reports whether a subtitle file holds anything a viewer
// could read. ffmpeg writes the header the moment the file is created, so its
// existence proves nothing.
func hasSubtitleCues(path string) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	marker := []byte(cueMarker)
	if isStyledSubtitle(path) {
		marker = []byte("Dialogue:")
	}
	// A WebVTT header is a handful of bytes; an ASS style table can run to a
	// few kilobytes before the first dialogue line.
	buffer := make([]byte, 64*1024)
	n, err := file.Read(buffer)
	if n <= 0 || (err != nil && !errors.Is(err, io.EOF)) {
		return false
	}
	return bytes.Contains(buffer[:n], marker)
}

// snapshotSubtitleWorkFile converts the cues a growing work file holds so far
// into the published VTT next to it: an ASS script through the full styled
// conversion, a plain .vtt.src through dialogue positioning.
func snapshotSubtitleWorkFile(workPath string) bool {
	data, err := os.ReadFile(workPath)
	if err != nil {
		return false
	}
	var vtt []byte
	var published string
	if isStyledSubtitle(workPath) {
		vtt = ConvertASSToVTT(data)
		published = strings.TrimSuffix(workPath, filepath.Ext(workPath)) + ".vtt"
	} else {
		vtt = positionDialogueCues(data)
		published = strings.TrimSuffix(workPath, ".src")
	}
	if len(vtt) == 0 {
		return false
	}
	return os.WriteFile(published, vtt, 0o644) == nil
}

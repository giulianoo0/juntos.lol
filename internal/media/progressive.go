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
	"strings"
	"sync"
	"time"

	"github.com/giulianoo0/ss/internal/metrics"
	"github.com/giulianoo0/ss/internal/room"
)

const (
	// masterPollInterval is how often a progressive job checks for the first
	// complete HLS segment produced by the growing upload.
	masterPollInterval = 250 * time.Millisecond
	// probeRetryInterval lets a partial container header grow before ffprobe
	// tries it again. Upload progress often arrives in the middle of a PATCH.
	probeRetryInterval = 500 * time.Millisecond
	// inputPollInterval is the maximum delay before new upload bytes are fed
	// to ffmpeg after it reaches the file's temporary EOF.
	inputPollInterval = 100 * time.Millisecond
)

type probeFunc func(context.Context, string) (*ProbeResult, error)

// progressiveJob is one partial upload awaiting a preview remux.
type progressiveJob struct {
	roomID  string
	srcPath string
	// size is the upload's declared total, used to turn the probed duration
	// into "how many bytes before this can play".
	size int64
}

// Progressive runs best-effort preview remuxes of still-growing uploads.
// The final remux started by Queue on upload completion stays authoritative:
// failures here only leave the room in its current state.
type Progressive struct {
	workers   int
	store     *room.Store
	dataDir   string
	publisher *Publisher
	// previewFloorBytes is the smallest sensible preview estimate: the
	// threshold that started this job in the first place.
	previewFloorBytes int64
	onReady           func(roomID string)
	// onUpdated tells clients the room's preparation metadata moved, without
	// claiming its media status changed.
	onUpdated func(roomID string)
	probe     probeFunc
	jobs      chan progressiveJob
	done      chan struct{}
	start     sync.Once
	mu        sync.Mutex
	ctx       context.Context
	started   bool
	stopping  bool
	queued    map[string]struct{}
	active    map[string]context.CancelFunc
	canceled  map[string]struct{}
	// previewStarted is when each accepted job was submitted, which is the
	// moment the wait a viewer actually feels begins: the upload has just
	// crossed the threshold and the waiting screen is up. It is consumed by
	// the announcement that ends that wait.
	previewStarted map[string]time.Time
	// unpreviewable remembers rooms whose source has no playable prefix.
	// Upload progress keeps arriving twice a second, and without this the
	// verdict would be re-reached, re-logged and re-published on every tick
	// for the whole download.
	unpreviewable map[string]struct{}
}

// NewProgressive creates a preview worker pool. onReady fires once per room
// when its first complete HLS segment is playable; onUpdated fires whenever
// the preview phase or its estimate changes.
func NewProgressive(workers int, store *room.Store, dataDir string, publisher *Publisher,
	previewFloorBytes int64, onReady, onUpdated func(roomID string)) *Progressive {
	if workers < 1 {
		workers = 1
	}
	return &Progressive{
		workers:           workers,
		store:             store,
		dataDir:           dataDir,
		publisher:         publisher,
		previewFloorBytes: previewFloorBytes,
		onReady:           onReady,
		onUpdated:         onUpdated,
		probe:             Probe,
		jobs:              make(chan progressiveJob, workers),
		done:              make(chan struct{}),
		queued:            make(map[string]struct{}),
		active:            make(map[string]context.CancelFunc),
		canceled:          make(map[string]struct{}),
		previewStarted:    make(map[string]time.Time),
		unpreviewable:     make(map[string]struct{}),
	}
}

// Start launches the worker pool once. Workers stop when ctx is canceled.
func (p *Progressive) Start(ctx context.Context) {
	p.start.Do(func() {
		p.mu.Lock()
		p.ctx = ctx
		p.started = true
		p.mu.Unlock()
		var workers sync.WaitGroup
		for range p.workers {
			workers.Go(func() { p.worker(ctx) })
		}
		go func() {
			workers.Wait()
			p.mu.Lock()
			p.stopping = true
			p.mu.Unlock()
			close(p.done)
		}()
	})
}

// Submit enqueues a preview remux for a partial upload. Duplicates and
// submissions after shutdown return without blocking.
func (p *Progressive) Submit(roomID, srcPath string, size int64) {
	p.mu.Lock()
	ctx := p.ctx
	if !p.started {
		p.mu.Unlock()
		slog.Warn("progressive submission before start", "room_id", roomID)
		return
	}
	if p.stopping || ctx == nil || ctx.Err() != nil {
		p.mu.Unlock()
		return
	}
	if _, exists := p.queued[roomID]; exists {
		p.mu.Unlock()
		return
	}
	if _, exists := p.active[roomID]; exists {
		p.mu.Unlock()
		return
	}
	if _, exists := p.unpreviewable[roomID]; exists {
		p.mu.Unlock()
		return
	}
	p.queued[roomID] = struct{}{}
	select {
	case <-ctx.Done():
		delete(p.queued, roomID)
		p.mu.Unlock()
	case p.jobs <- progressiveJob{roomID: roomID, srcPath: srcPath, size: size}:
		p.previewStarted[roomID] = time.Now()
		p.mu.Unlock()
		metrics.FFmpegJobsQueued.WithLabelValues(metrics.PipelinePreview).Inc()
	default:
		delete(p.queued, roomID)
		p.mu.Unlock()
		metrics.FFmpegJobs.WithLabelValues(metrics.PipelinePreview, metrics.JobRejected).Inc()
		slog.WarnContext(ctx, "progressive queue full", "room_id", roomID)
	}
}

// Cancel stops a running preview for roomID and drops a queued one. The
// upload completion and termination paths call this once the partial file is
// no longer valid input.
func (p *Progressive) Cancel(roomID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if cancel, ok := p.active[roomID]; ok {
		cancel()
	}
	if _, ok := p.queued[roomID]; ok {
		p.canceled[roomID] = struct{}{}
	}
	// The source is being retired, so its verdict goes with it: a replacement
	// deserves to be judged on its own.
	delete(p.unpreviewable, roomID)
}

func (p *Progressive) worker(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case job := <-p.jobs:
			jobCtx, ok := p.beginJob(ctx, job.roomID)
			if !ok {
				continue
			}
			started := time.Now()
			outcome := p.process(ctx, jobCtx, job)
			metrics.FFmpegJobs.WithLabelValues(metrics.PipelinePreview, outcome).Inc()
			metrics.FFmpegJobDuration.WithLabelValues(metrics.PipelinePreview, outcome).
				Observe(time.Since(started).Seconds())
			p.finishJob(job.roomID)
		}
	}
}

// beginJob registers a per-job context cancel and reports whether the job
// should run (a canceled queued job is dropped).
func (p *Progressive) beginJob(ctx context.Context, roomID string) (context.Context, bool) {
	p.mu.Lock()
	delete(p.queued, roomID)
	if _, ok := p.canceled[roomID]; ok {
		delete(p.canceled, roomID)
		delete(p.previewStarted, roomID)
		p.mu.Unlock()
		metrics.FFmpegJobsQueued.WithLabelValues(metrics.PipelinePreview).Dec()
		metrics.FFmpegJobs.WithLabelValues(metrics.PipelinePreview, metrics.JobCanceled).Inc()
		return nil, false
	}
	jobCtx, cancel := context.WithCancel(ctx)
	p.active[roomID] = cancel
	p.mu.Unlock()
	metrics.FFmpegJobsQueued.WithLabelValues(metrics.PipelinePreview).Dec()
	metrics.FFmpegJobsRunning.WithLabelValues(metrics.PipelinePreview).Inc()
	return jobCtx, true
}

func (p *Progressive) finishJob(roomID string) {
	p.mu.Lock()
	delete(p.active, roomID)
	// A job that ended without the room ever becoming playable leaves its
	// start time behind, and the map would otherwise hold one per room the
	// server ever previewed.
	delete(p.previewStarted, roomID)
	p.mu.Unlock()
	metrics.FFmpegJobsRunning.WithLabelValues(metrics.PipelinePreview).Dec()
}

// process runs one preview job and reports how it ended.
//
// The outcome is returned rather than inferred by the caller because most of
// the ways this stops are not failures: a source with no decodable prefix is
// a verdict, and a job cut short by a source swap is a cancellation. Counting
// either as a failure would put a permanent red line on a dashboard that
// nobody can act on, which is the fastest way to teach people to ignore it.
func (p *Progressive) process(ctx, jobCtx context.Context, job progressiveJob) string {
	if err := p.store.SetStatus(jobCtx, job.roomID, "processing"); err != nil {
		slog.WarnContext(ctx, "progressive: set processing status failed",
			"room_id", job.roomID, "error", err)
		return outcomeFor(jobCtx, metrics.JobFailed)
	}
	p.setPhase(jobCtx, ctx, job.roomID, room.PreviewProbing, 0)
	probe, err := probeGrowingFile(jobCtx, job.srcPath, probeRetryInterval, p.probe)
	if err != nil {
		if errors.Is(err, ErrContainerUnknown) {
			// The file cannot be previewed at all, so stop burning an ffprobe
			// every half second on it and say so: the final remux still runs
			// when the upload lands, and until then the room can tell viewers
			// the truth instead of showing a preparing screen that never ends.
			slog.InfoContext(ctx, "progressive: source has no streamable prefix",
				"room_id", job.roomID)
			p.markUnpreviewable(job.roomID)
			p.setPhase(jobCtx, ctx, job.roomID, room.PreviewUnavailable, 0)
			// Not a failure: the source is simply one the final remux has to
			// handle on its own, and it said so instead of retrying forever.
			return metrics.JobSucceeded
		}
		if !errors.Is(err, context.Canceled) {
			slog.WarnContext(ctx, "progressive: probe growing upload failed",
				"room_id", job.roomID, "error", err)
		}
		return outcomeFor(jobCtx, metrics.JobFailed)
	}
	p.setPhase(jobCtx, ctx, job.roomID, room.PreviewSegmenting,
		PreviewTargetBytes(job.size, probe.DurationMs, p.previewFloorBytes))
	metrics.VideoHandling.WithLabelValues(metrics.PipelinePreview, videoHandling(probe)).Inc()
	slog.InfoContext(ctx, "progressive preview starting",
		"room_id", job.roomID,
		"video_codec", probe.VideoCodec,
		"video_copyable", probe.VideoCopyable,
		"audio_tracks", len(probe.Audio),
	)
	hlsDir := filepath.Join(p.dataDir, "rooms", job.roomID, "hls")
	if err := os.MkdirAll(hlsDir, 0o755); err != nil {
		slog.WarnContext(ctx, "progressive: create HLS directory failed",
			"room_id", job.roomID, "error", err)
		return outcomeFor(jobCtx, metrics.JobFailed)
	}
	// Subtitles run alongside the video rather than after it: a viewer who can
	// already watch the first minutes should be able to read them too.
	go p.extractSubtitles(ctx, jobCtx, job, probe)
	// Publishing runs alongside the remux for the same reason: a preview that
	// only reached the bucket at the end would not be a preview.
	publishing := make(chan struct{})
	go func() {
		defer close(publishing)
		p.publisher.Run(jobCtx, job.roomID, hlsDir, previewPublishPatterns)
	}()
	p.remux(ctx, jobCtx, job, hlsDir, probe)
	// The publisher makes one last pass once the remux stops, so on a source
	// that arrives all at once the preview only becomes reachable here, after
	// the loop that would have announced it has already exited.
	<-publishing
	p.announcePreview(ctx, job.roomID, probe)
	return outcomeFor(jobCtx, metrics.JobSucceeded)
}

// outcomeFor reports a cancelled job as cancelled whatever else went wrong on
// the way out. A source swap tears down the store writes, the ffmpeg process
// and the publisher all at once, and every one of them then reports an error
// that is really just the shutdown arriving.
func outcomeFor(jobCtx context.Context, outcome string) string {
	if jobCtx.Err() != nil {
		return metrics.JobCanceled
	}
	return outcome
}

// announcePreview makes a room ready once its preview is reachable, for the
// case where that only happened after the remux ended. A room left unannounced
// advertises "preparing" for the whole final encode with watchable media
// already sitting in the bucket.
func (p *Progressive) announcePreview(ctx context.Context, roomID string, probe *ProbeResult) {
	if ctx.Err() != nil || !p.previewPlayable(ctx, roomID, probe) {
		return
	}
	storedRoom, err := p.store.Get(ctx, roomID)
	if err != nil || storedRoom.Status == "ready" {
		return
	}
	if err := p.store.SetStatus(ctx, roomID, "ready"); err != nil {
		slog.WarnContext(ctx, "progressive: announce preview failed", "room_id", roomID, "error", err)
		return
	}
	slog.InfoContext(ctx, "progressive preview ready after final publish", "room_id", roomID)
	p.notifyReady(roomID)
}

// remux runs the progressive ffmpeg pass. A blocking stdin feeder follows the
// growing file, so a temporary EOF pauses ffmpeg instead of ending the job.
// The room becomes ready only after the first complete HLS segment appears.
func (p *Progressive) remux(ctx, jobCtx context.Context, job progressiveJob, hlsDir string, probe *ProbeResult) {
	cmd := exec.CommandContext(jobCtx, "ffmpeg", BuildProgressiveRemuxArgs("pipe:0", hlsDir, probe)...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		slog.WarnContext(ctx, "progressive: create ffmpeg input failed",
			"room_id", job.roomID, "error", err)
		return
	}
	if err := cmd.Start(); err != nil {
		slog.WarnContext(ctx, "progressive: start ffmpeg failed",
			"room_id", job.roomID, "error", err)
		return
	}
	inputCtx, stopInput := context.WithCancel(jobCtx)
	defer stopInput()
	inputErr := make(chan error, 1)
	go func() {
		err := streamGrowingFile(inputCtx, job.srcPath, stdin, inputPollInterval)
		if closeErr := stdin.Close(); err == nil {
			err = closeErr
		}
		inputErr <- err
	}()
	waitErr := make(chan error, 1)
	go func() { waitErr <- cmd.Wait() }()

	ticker := time.NewTicker(masterPollInterval)
	defer ticker.Stop()
	notified := false
	inputDone := false
	for {
		select {
		case err := <-waitErr:
			stopInput()
			_ = stdin.Close()
			if !inputDone {
				<-inputErr
			}
			switch {
			case err == nil:
				slog.InfoContext(ctx, "progressive remux finished", "room_id", job.roomID)
			case jobCtx.Err() != nil:
				slog.InfoContext(ctx, "progressive remux stopped", "room_id", job.roomID)
			default:
				slog.InfoContext(ctx, "progressive remux exited early",
					"room_id", job.roomID,
					"error", err,
					"stderr", stderrTail(stderr.Bytes(), ffmpegErrorTailBytes),
				)
			}
			return
		case err := <-inputErr:
			inputDone = true
			if err != nil && jobCtx.Err() == nil && !errors.Is(err, io.ErrClosedPipe) {
				slog.WarnContext(ctx, "progressive: growing input stopped",
					"room_id", job.roomID, "error", err)
			}
		case <-ticker.C:
			if notified {
				continue
			}
			if !p.previewPlayable(jobCtx, job.roomID, probe) {
				continue
			}
			// The preview playlist needs the same codec label as the final
			// one, or the preview becomes the part that fails silently.
			if err := annotateHEVCMaster(hlsDir, "master.m3u8", "preview_init_*.mp4", probe); err != nil {
				slog.WarnContext(ctx, "annotate preview codecs failed",
					"room_id", job.roomID, "error", err)
			}
			if err := p.store.SetStatus(jobCtx, job.roomID, "ready"); err != nil {
				slog.WarnContext(ctx, "progressive: set ready status failed",
					"room_id", job.roomID, "error", err)
				continue
			}
			slog.InfoContext(ctx, "progressive preview ready", "room_id", job.roomID)
			p.notifyReady(job.roomID)
			notified = true
		}
	}
}

// previewPlayable reports whether the room can be announced as ready.
//
// The question is not what ffmpeg has written but what a viewer would be
// handed: the published playlist is cut at the last segment the bucket has
// confirmed, so a segment on disk that has not been uploaded does not count.
//
// It asks the video variant specifically. Audio variants publish fixed-length
// segments quickly while a copied video track can only split at source
// keyframes, so "some segment exists" can announce a room whose video is still
// empty — a viewer would hear sound over a black frame.
func (p *Progressive) previewPlayable(ctx context.Context, roomID string, probe *ProbeResult) bool {
	if ready, err := p.store.HasPlaylist(ctx, roomID, "master.m3u8"); err != nil || !ready {
		return false
	}
	playlist, err := p.store.Playlist(ctx, roomID, previewVideoVariantPlaylist(probe))
	if err != nil {
		return false
	}
	return strings.Contains(playlist, "#EXTINF")
}

// probeGrowingFile retries transient parse failures until enough of the
// container header has arrived or the upload is canceled/completed.
func probeGrowingFile(ctx context.Context, path string, retryInterval time.Duration,
	probe probeFunc) (*ProbeResult, error) {
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		result, err := probe(ctx, path)
		if err == nil && result != nil && result.VideoCodec != "" {
			return result, nil
		}
		// Retrying forever is right for a header that is still arriving and
		// wrong for one that will only ever arrive last. Which of the two this
		// is, is written in the first few kilobytes, so ask them rather than
		// waiting out a timeout that would be arbitrary either way.
		if whole, layoutErr := NeedsWholeFile(path); layoutErr == nil && whole {
			return nil, ErrContainerUnknown
		}

		timer := time.NewTimer(retryInterval)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}

// streamGrowingFile copies bytes already present and then waits at temporary
// EOF for appended upload bytes. Keeping ffmpeg's stdin open is what turns a
// regular tus file into an actual streaming input.
func streamGrowingFile(ctx context.Context, path string, dst io.Writer, pollInterval time.Duration) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()

	buffer := make([]byte, 256*1024)
	for {
		n, readErr := file.Read(buffer)
		if n > 0 {
			if _, err := dst.Write(buffer[:n]); err != nil {
				return err
			}
		}
		if readErr == nil {
			continue
		}
		if !errors.Is(readErr, io.EOF) {
			return readErr
		}

		timer := time.NewTimer(pollInterval)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			return ctx.Err()
		case <-timer.C:
		}
	}
}

// previewVideoVariantPlaylist names the media playlist of the preview's video
// rendition. The preview is a single variant carrying its own audio, so there
// is only ever one, whether or not the source has sound.
func previewVideoVariantPlaylist(*ProbeResult) string {
	return "preview_stream_0.m3u8"
}

func hasNonEmptyMatch(pattern string) bool {
	matches, err := filepath.Glob(pattern)
	if err != nil {
		return false
	}
	for _, match := range matches {
		if info, err := os.Stat(match); err == nil && info.Size() > 0 {
			return true
		}
	}
	return false
}

// markUnpreviewable records that this room's source will never yield a
// preview, so the verdict is reached once rather than on every progress tick.
func (p *Progressive) markUnpreviewable(roomID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.unpreviewable[roomID] = struct{}{}
}

// setPhase records how far a preview has got. It is advisory: a room that
// cannot be told is still being prepared, so a failure here must never stop
// the remux.
func (p *Progressive) setPhase(jobCtx, ctx context.Context, roomID, phase string, targetBytes int64) {
	if err := p.store.SetPreviewPhase(jobCtx, roomID, phase, targetBytes); err != nil {
		slog.WarnContext(ctx, "progressive: set preview phase failed",
			"room_id", roomID, "phase", phase, "error", err)
		return
	}
	p.notifyUpdated(roomID)
}

// notifyUpdated tells connected clients that the room's preparation moved.
func (p *Progressive) notifyUpdated(roomID string) {
	if p.onUpdated == nil {
		return
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			slog.Error("progressive updated callback panicked", "room_id", roomID, "panic", recovered)
		}
	}()
	p.onUpdated(roomID)
}

func (p *Progressive) notifyReady(roomID string) {
	p.recordPreviewReady(roomID)
	if p.onReady == nil {
		return
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			slog.Error("progressive ready callback panicked", "room_id", roomID, "panic", recovered)
		}
	}()
	p.onReady(roomID)
}

// recordPreviewReady closes out the wait a viewer felt: from the upload
// crossing the threshold that started this job to the room being playable.
//
// The start time is consumed, not merely read. A room is announced ready at
// most once per job, but the two places that can announce it are reached by
// different paths — one while the remux is still running, one after it has
// stopped — and a job that took both would otherwise be measured twice.
func (p *Progressive) recordPreviewReady(roomID string) {
	p.mu.Lock()
	started, ok := p.previewStarted[roomID]
	delete(p.previewStarted, roomID)
	p.mu.Unlock()
	if ok {
		metrics.PreviewReadyDuration.Observe(time.Since(started).Seconds())
	}
}

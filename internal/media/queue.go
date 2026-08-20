package media

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/giulianoo0/ss/internal/room"
)

const (
	publicPipelineError    = "media processing failed"
	publicPipelineCanceled = "media processing canceled"
	publicQueueFullError   = "media queue is full"
	queueRejectTimeout     = 2 * time.Second
)

// Pipeline processes one uploaded source into browser-ready media tracks.
// skipSubs skips embedded subtitle extraction when the browser already
// supplied WebVTT tracks.
type Pipeline interface {
	Run(ctx context.Context, roomID, srcPath, outDir string, skipSubs bool) (
		audio, subs []room.TrackInfo, bitmapSkipped int, err error,
	)
}

// Queue owns a bounded media-job channel and a fixed worker pool.
type Queue struct {
	workers   int
	store     *room.Store
	dataDir   string
	publisher *Publisher
	onReady   func(roomID string)
	pipeline  Pipeline
	jobs      chan string
	done      chan struct{}
	start     sync.Once
	mu        sync.Mutex
	ctx       context.Context
	started   bool
	stopping  bool
	queued    map[string]struct{}
	active    map[string]struct{}
}

// NewQueue creates a queue backed by the real ffmpeg pipeline.
func NewQueue(workers int, store *room.Store, dataDir string, publisher *Publisher,
	onReady func(roomID string)) *Queue {
	return newQueue(workers, store, dataDir, publisher, onReady, realPipeline{})
}

func newQueue(workers int, store *room.Store, dataDir string, publisher *Publisher,
	onReady func(string), pipeline Pipeline) *Queue {
	if workers < 1 {
		workers = 1
	}
	return &Queue{
		workers:   workers,
		store:     store,
		dataDir:   dataDir,
		publisher: publisher,
		onReady:   onReady,
		pipeline:  pipeline,
		jobs:      make(chan string, workers),
		done:      make(chan struct{}),
		queued:    make(map[string]struct{}),
		active:    make(map[string]struct{}),
	}
}

// Start launches the worker pool once. Workers stop when ctx is canceled.
func (q *Queue) Start(ctx context.Context) {
	q.start.Do(func() {
		q.mu.Lock()
		q.ctx = ctx
		q.started = true
		q.mu.Unlock()
		var workers sync.WaitGroup
		for range q.workers {
			workers.Go(func() { q.worker(ctx) })
		}
		go func() {
			workers.Wait()
			for _, roomID := range q.stopAndDrain() {
				q.markCanceled(ctx, roomID)
			}
			close(q.done)
		}()
	})
}

// Recover resubmits complete uploads whose in-memory final-remux job was lost
// during a process restart. Rooms with only a growing tus file are left to the
// progressive upload callback; an original.* file means completion was already
// committed and the authoritative pipeline can safely restart from byte zero.
func (q *Queue) Recover(ctx context.Context) error {
	roomsDir := filepath.Join(q.dataDir, "rooms")
	entries, err := os.ReadDir(roomsDir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read rooms for media recovery: %w", err)
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		roomID := entry.Name()
		storedRoom, err := q.store.Get(ctx, roomID)
		if err != nil {
			if !errors.Is(err, room.ErrNotFound) {
				slog.WarnContext(ctx, "load room for media recovery failed", "room_id", roomID, "error", err)
			}
			continue
		}
		if storedRoom.Status != "uploading" && storedRoom.Status != "processing" {
			continue
		}
		if _, _, err := sourcePath(q.dataDir, roomID); err != nil {
			continue
		}
		slog.InfoContext(ctx, "recovering interrupted media job", "room_id", roomID)
		q.Submit(roomID)
	}
	return nil
}

// Submit enqueues roomID, or returns without blocking after the queue stops.
func (q *Queue) Submit(roomID string) {
	q.mu.Lock()
	ctx := q.ctx
	if !q.started {
		q.mu.Unlock()
		slog.Warn("media queue submission before start", "room_id", roomID)
		return
	}
	if q.stopping || ctx == nil || ctx.Err() != nil {
		q.mu.Unlock()
		return
	}
	if _, exists := q.queued[roomID]; exists {
		q.mu.Unlock()
		return
	}
	if _, exists := q.active[roomID]; exists {
		q.mu.Unlock()
		return
	}
	q.queued[roomID] = struct{}{}
	select {
	case <-ctx.Done():
		delete(q.queued, roomID)
		q.mu.Unlock()
		return
	case q.jobs <- roomID:
		q.mu.Unlock()
		return
	default:
		delete(q.queued, roomID)
		q.mu.Unlock()
		q.rejectFull(ctx, roomID)
	}
}

func (q *Queue) rejectFull(ctx context.Context, roomID string) {
	rejectCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), queueRejectTimeout)
	defer cancel()
	slog.WarnContext(rejectCtx, "media queue full", "room_id", roomID)
	if err := q.store.SetError(rejectCtx, roomID, publicQueueFullError); err != nil {
		slog.ErrorContext(rejectCtx, "persist media queue rejection failed", "room_id", roomID, "error", err)
	}
}

func (q *Queue) worker(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case roomID := <-q.jobs:
			q.beginJob(roomID)
			if ctx.Err() != nil {
				q.markCanceled(ctx, roomID)
				q.finishJob(roomID)
				return
			}
			completed := q.process(ctx, roomID)
			if !completed && ctx.Err() != nil {
				q.markCanceled(ctx, roomID)
			}
			q.finishJob(roomID)
		}
	}
}

func (q *Queue) process(ctx context.Context, roomID string) bool {
	storedRoom, err := q.store.Get(ctx, roomID)
	if err != nil {
		if ctx.Err() == nil {
			q.fail(ctx, roomID, fmt.Errorf("load room before processing: %w", err))
		}
		return false
	}
	roomDir, srcPath, err := sourcePath(q.dataDir, roomID)
	if err != nil {
		if ctx.Err() == nil {
			q.fail(ctx, roomID, err)
		}
		return false
	}

	// A completed upload may already have a playable progressive preview, which
	// stays visible while the authoritative remux runs — including when this
	// job is being recovered after a restart. Whether there is one is recorded
	// in the published playlists, not on disk: the segments themselves have
	// been handed to the bucket and deleted.
	previewPublished, err := q.store.HasPlaylist(ctx, roomID, "master.m3u8")
	if err != nil {
		if ctx.Err() == nil {
			q.fail(ctx, roomID, fmt.Errorf("check published preview: %w", err))
		}
		return false
	}
	keepReady := storedRoom.Status == "ready" || previewPublished
	if !keepReady {
		// The preview announces itself once its last publish lands, which can
		// happen between the read above and the write below. Re-reading keeps
		// this job from taking a room that just became watchable back to
		// "preparing" for the length of the whole encode.
		if fresh, freshErr := q.store.Get(ctx, roomID); freshErr == nil && fresh.Status == "ready" {
			keepReady = true
		}
	}
	nextStatus := "processing"
	if keepReady {
		nextStatus = "ready"
	}
	if err := q.store.SetStatus(ctx, roomID, nextStatus); err != nil {
		if ctx.Err() == nil {
			q.fail(ctx, roomID, fmt.Errorf("set %s status: %w", nextStatus, err))
		}
		return false
	}
	if keepReady && storedRoom.Status != "ready" {
		q.notifyReady(roomID)
	}
	skipSubs, err := q.store.HasClientSubs(ctx, roomID)
	if err != nil {
		if ctx.Err() == nil {
			q.fail(ctx, roomID, fmt.Errorf("check client subtitles: %w", err))
		}
		return false
	}
	// Publishing runs alongside the encode so segments leave the disk as they
	// are written, then once more afterwards as the authoritative pass: the
	// first is best effort, the second decides whether the room has media.
	hlsDir := filepath.Join(roomDir, "hls")
	publishCtx, stopPublishing := context.WithCancel(ctx)
	publishing := make(chan struct{})
	go func() {
		defer close(publishing)
		q.publisher.Run(publishCtx, roomID, hlsDir, finalPublishPatterns)
	}()

	audio, subs, bitmapSkipped, err := q.pipeline.Run(ctx, roomID, srcPath, roomDir, skipSubs)
	stopPublishing()
	<-publishing
	if err != nil {
		if ctx.Err() == nil {
			q.fail(ctx, roomID, err)
		}
		return false
	}
	if err := q.publisher.Publish(ctx, roomID, hlsDir, finalPublishPatterns); err != nil {
		if ctx.Err() == nil {
			q.fail(ctx, roomID, fmt.Errorf("publish final media: %w", err))
		}
		return false
	}
	if err := q.publisher.PublishSubtitles(ctx, roomID, filepath.Join(roomDir, "subs")); err != nil {
		if ctx.Err() == nil {
			q.fail(ctx, roomID, fmt.Errorf("publish subtitles: %w", err))
		}
		return false
	}
	if skipSubs {
		err = q.store.SetAudioTracks(ctx, roomID, audio, bitmapSkipped)
	} else {
		err = q.store.SetTracks(ctx, roomID, audio, subs, bitmapSkipped)
	}
	if err != nil {
		if ctx.Err() == nil {
			q.fail(ctx, roomID, fmt.Errorf("store media tracks: %w", err))
		}
		return false
	}
	// The version moves before the ready broadcast, so the refetch the
	// broadcast triggers is guaranteed to observe the republished media.
	if err := q.store.BumpMediaVersion(ctx, roomID); err != nil {
		if ctx.Err() == nil {
			q.fail(ctx, roomID, fmt.Errorf("bump media version: %w", err))
		}
		return false
	}
	if err := q.store.SetStatus(ctx, roomID, "ready"); err != nil {
		if ctx.Err() == nil {
			q.fail(ctx, roomID, fmt.Errorf("set ready status: %w", err))
		}
		return false
	}
	slog.InfoContext(ctx, "final media published", "room_id", roomID)
	// The source exists to be encoded, and the encode is published. Recovery
	// after a restart only ever looks at rooms still uploading or processing,
	// so from here it is a few hundred megabytes held for nothing.
	if err := os.Remove(srcPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		slog.WarnContext(ctx, "remove encoded source failed", "room_id", roomID, "error", err)
	}
	q.notifyReady(roomID)
	return true
}

func (q *Queue) beginJob(roomID string) {
	q.mu.Lock()
	delete(q.queued, roomID)
	q.active[roomID] = struct{}{}
	q.mu.Unlock()
}

func (q *Queue) finishJob(roomID string) {
	q.mu.Lock()
	delete(q.active, roomID)
	q.mu.Unlock()
}

func (q *Queue) stopAndDrain() []string {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.stopping = true

	var roomIDs []string
	for {
		select {
		case roomID := <-q.jobs:
			delete(q.queued, roomID)
			roomIDs = append(roomIDs, roomID)
		default:
			return roomIDs
		}
	}
}

func (q *Queue) markCanceled(ctx context.Context, roomID string) {
	persistCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), queueRejectTimeout)
	defer cancel()
	if err := q.store.SetError(persistCtx, roomID, publicPipelineCanceled); err != nil {
		slog.ErrorContext(persistCtx, "persist media cancellation failed", "room_id", roomID, "error", err)
	}
}

func (q *Queue) fail(ctx context.Context, roomID string, err error) {
	slog.ErrorContext(ctx, "media pipeline failed", "room_id", roomID, "error", err)
	if storeErr := q.store.SetError(ctx, roomID, publicPipelineError); storeErr != nil {
		slog.ErrorContext(ctx, "persist media pipeline error failed",
			"room_id", roomID,
			"pipeline_error", err,
			"store_error", storeErr,
		)
	}
}

func (q *Queue) notifyReady(roomID string) {
	if q.onReady == nil {
		return
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			slog.Error("media ready callback panicked", "room_id", roomID, "panic", recovered)
		}
	}()
	q.onReady(roomID)
}

func sourcePath(dataDir, roomID string) (roomDir, srcPath string, err error) {
	if roomID == "." || strings.ContainsAny(roomID, "*?[]") ||
		!filepath.IsLocal(roomID) || filepath.Base(roomID) != roomID {
		return "", "", fmt.Errorf("invalid room id")
	}
	roomDir = filepath.Join(dataDir, "rooms", roomID)
	entries, err := os.ReadDir(roomDir)
	if err != nil {
		return "", "", fmt.Errorf("read room media directory: %w", err)
	}
	for _, entry := range entries {
		name := entry.Name()
		if name != "original" && !strings.HasPrefix(name, "original.") {
			continue
		}
		path := filepath.Join(roomDir, name)
		info, err := os.Lstat(path)
		if err != nil {
			return "", "", fmt.Errorf("inspect original media: %w", err)
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return "", "", fmt.Errorf("original media is not a regular file")
		}
		if srcPath != "" {
			return "", "", fmt.Errorf("multiple original media files")
		}
		srcPath = path
	}
	if srcPath == "" {
		return "", "", fmt.Errorf("original media not found")
	}
	return roomDir, srcPath, nil
}

type realPipeline struct{}

func (realPipeline) Run(ctx context.Context, roomID string, srcPath, outDir string, skipSubs bool) (
	[]room.TrackInfo, []room.TrackInfo, int, error,
) {
	probe, err := Probe(ctx, srcPath)
	if err != nil {
		return nil, nil, 0, err
	}
	slog.InfoContext(ctx, "final remux starting",
		"room_id", roomID,
		"video_codec", probe.VideoCodec,
		"video_copyable", probe.VideoCopyable,
		"duration_ms", probe.DurationMs,
		"audio_tracks", len(probe.Audio),
	)
	hlsDir := filepath.Join(outDir, "hls")
	if err := os.MkdirAll(hlsDir, 0o755); err != nil {
		return nil, nil, 0, fmt.Errorf("create HLS directory: %w", err)
	}
	if err := Remux(ctx, srcPath, hlsDir, probe); err != nil {
		return nil, nil, 0, err
	}
	slog.InfoContext(ctx, "final HLS master published", "room_id", roomID)
	if err := finalizeProgressiveOutputs(hlsDir); err != nil {
		slog.WarnContext(ctx, "finalize progressive media failed", "room_id", roomID, "error", err)
	} else {
		slog.InfoContext(ctx, "progressive preview finalized", "room_id", roomID)
	}
	subsDir := filepath.Join(outDir, "subs")
	if skipSubs {
		return probe.Audio, nil, probe.BitmapSubs, nil
	}
	if _, err := ExtractSubtitles(ctx, srcPath, subsDir, probe); err != nil {
		return nil, nil, 0, err
	}
	// Sibling subtitle files published while the source was still arriving sit
	// after the embedded ones in the final list, and their files are renumbered
	// to match. Losing them here is not worth failing the remux over.
	subtitles, err := MergeExternalSubtitles(subsDir, probe.Subtitles)
	if err != nil {
		slog.WarnContext(ctx, "merge external subtitles failed", "room_id", roomID, "error", err)
		subtitles = probe.Subtitles
	}
	return probe.Audio, subtitles, probe.BitmapSubs, nil
}

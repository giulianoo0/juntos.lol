package media

import (
	"context"
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
	publicPipelineError  = "media processing failed"
	publicQueueFullError = "media queue is full"
	queueRejectTimeout   = 2 * time.Second
)

// Pipeline processes one uploaded source into browser-ready media tracks.
type Pipeline interface {
	Run(ctx context.Context, roomID, srcPath, outDir string) (
		audio, subs []room.TrackInfo, bitmapSkipped int, err error,
	)
}

// Queue owns a bounded media-job channel and a fixed worker pool.
type Queue struct {
	workers  int
	store    *room.Store
	dataDir  string
	onReady  func(roomID string)
	pipeline Pipeline
	jobs     chan string
	done     chan struct{}
	start    sync.Once
	mu       sync.Mutex
	ctx      context.Context
}

// NewQueue creates a queue backed by the real ffmpeg pipeline.
func NewQueue(workers int, store *room.Store, dataDir string, onReady func(roomID string)) *Queue {
	return newQueue(workers, store, dataDir, onReady, realPipeline{})
}

func newQueue(workers int, store *room.Store, dataDir string, onReady func(string), pipeline Pipeline) *Queue {
	if workers < 1 {
		workers = 1
	}
	return &Queue{
		workers:  workers,
		store:    store,
		dataDir:  dataDir,
		onReady:  onReady,
		pipeline: pipeline,
		jobs:     make(chan string, workers),
		done:     make(chan struct{}),
	}
}

// Start launches the worker pool once. Workers stop when ctx is canceled.
func (q *Queue) Start(ctx context.Context) {
	q.start.Do(func() {
		q.mu.Lock()
		q.ctx = ctx
		q.mu.Unlock()
		var workers sync.WaitGroup
		for range q.workers {
			workers.Go(func() { q.worker(ctx) })
		}
		go func() {
			workers.Wait()
			close(q.done)
		}()
	})
}

// Submit enqueues roomID, or returns without blocking after the queue stops.
func (q *Queue) Submit(roomID string) {
	q.mu.Lock()
	ctx := q.ctx
	q.mu.Unlock()
	if ctx == nil || ctx.Err() != nil {
		return
	}
	select {
	case q.jobs <- roomID:
	default:
		rejectCtx, cancel := context.WithTimeout(ctx, queueRejectTimeout)
		defer cancel()
		slog.WarnContext(rejectCtx, "media queue full", "room_id", roomID)
		if err := q.store.SetError(rejectCtx, roomID, publicQueueFullError); err != nil {
			slog.ErrorContext(rejectCtx, "persist media queue rejection failed", "room_id", roomID, "error", err)
		}
	}
}

func (q *Queue) worker(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case roomID := <-q.jobs:
			if ctx.Err() != nil {
				return
			}
			q.process(ctx, roomID)
		}
	}
}

func (q *Queue) process(ctx context.Context, roomID string) {
	if err := q.store.SetStatus(ctx, roomID, "processing"); err != nil {
		if ctx.Err() == nil {
			q.fail(ctx, roomID, fmt.Errorf("set processing status: %w", err))
		}
		return
	}

	roomDir, srcPath, err := sourcePath(q.dataDir, roomID)
	if err != nil {
		q.fail(ctx, roomID, err)
		return
	}
	audio, subs, bitmapSkipped, err := q.pipeline.Run(ctx, roomID, srcPath, roomDir)
	if err != nil {
		if ctx.Err() == nil {
			q.fail(ctx, roomID, err)
		}
		return
	}
	if err := q.store.SetTracks(ctx, roomID, audio, subs, bitmapSkipped); err != nil {
		q.fail(ctx, roomID, fmt.Errorf("store media tracks: %w", err))
		return
	}
	if err := q.store.SetStatus(ctx, roomID, "ready"); err != nil {
		q.fail(ctx, roomID, fmt.Errorf("set ready status: %w", err))
		return
	}
	q.notifyReady(roomID)
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
	if roomID == "." || !filepath.IsLocal(roomID) || filepath.Base(roomID) != roomID {
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

func (realPipeline) Run(ctx context.Context, _ string, srcPath, outDir string) (
	[]room.TrackInfo, []room.TrackInfo, int, error,
) {
	probe, err := Probe(ctx, srcPath)
	if err != nil {
		return nil, nil, 0, err
	}
	hlsDir := filepath.Join(outDir, "hls")
	if err := os.MkdirAll(hlsDir, 0o755); err != nil {
		return nil, nil, 0, fmt.Errorf("create HLS directory: %w", err)
	}
	if err := Remux(ctx, srcPath, hlsDir, probe); err != nil {
		return nil, nil, 0, err
	}
	if _, err := ExtractSubtitles(ctx, srcPath, filepath.Join(outDir, "subs"), probe); err != nil {
		return nil, nil, 0, err
	}
	return probe.Audio, probe.Subtitles, probe.BitmapSubs, nil
}

package media

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/room"
)

type pipelineFunc func(ctx context.Context, roomID, srcPath, outDir string) (
	audio, subs []room.TrackInfo, bitmapSkipped int, err error,
)

func (f pipelineFunc) Run(ctx context.Context, roomID, srcPath, outDir string) (
	[]room.TrackInfo, []room.TrackInfo, int, error,
) {
	return f(ctx, roomID, srcPath, outDir)
}

func TestQueueProcessesRoomAndNotifiesReady(t *testing.T) {
	store, dataDir := newQueueTestStore(t, "r1")
	wantAudio := []room.TrackInfo{{Index: 0, Language: "eng"}, {Index: 1, Language: "jpn"}}
	wantSubs := []room.TrackInfo{{Index: 0, Language: "por", Codec: "subrip"}}
	ready := make(chan string, 1)
	type pipelineCall struct{ roomID, srcPath, outDir string }
	calls := make(chan pipelineCall, 1)
	pipe := pipelineFunc(func(ctx context.Context, roomID, srcPath, outDir string) (
		[]room.TrackInfo, []room.TrackInfo, int, error,
	) {
		calls <- pipelineCall{roomID: roomID, srcPath: srcPath, outDir: outDir}
		return wantAudio, wantSubs, 2, nil
	})
	q := newQueue(1, store, dataDir, func(roomID string) { ready <- roomID }, pipe)
	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	q.Start(ctx)

	q.Submit("r1")

	select {
	case roomID := <-ready:
		require.Equal(t, "r1", roomID)
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for ready callback")
	}
	call := <-calls
	require.Equal(t, "r1", call.roomID)
	require.Equal(t, filepath.Join(dataDir, "rooms", "r1", "original.mkv"), call.srcPath)
	require.Equal(t, filepath.Join(dataDir, "rooms", "r1"), call.outDir)
	got, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, "ready", got.Status)
	require.Equal(t, wantAudio, got.AudioTracks)
	require.Equal(t, wantSubs, got.SubtitleTracks)
	require.Equal(t, 2, got.BitmapSubsSkipped)
}

func TestQueuePersistsPipelineError(t *testing.T) {
	store, dataDir := newQueueTestStore(t, "r2")
	originalLogger := slog.Default()
	var logs bytes.Buffer
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(originalLogger) })
	pipe := pipelineFunc(func(context.Context, string, string, string) (
		[]room.TrackInfo, []room.TrackInfo, int, error,
	) {
		return nil, nil, 0, errors.New("probe failed")
	})
	q := newQueue(1, store, dataDir, nil, pipe)
	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	q.Start(ctx)

	q.Submit("r2")

	require.Eventually(t, func() bool {
		got, err := store.Get(t.Context(), "r2")
		return err == nil && got.Status == "error" && got.ErrorMessage == "media processing failed"
	}, time.Second, 10*time.Millisecond)
	require.Contains(t, logs.String(), "probe failed")
}

func TestQueueSubmitDoesNotBlockWhenWorkersAreBusy(t *testing.T) {
	store, dataDir := newQueueTestStore(t, "busy")
	originalLogger := slog.Default()
	var logs bytes.Buffer
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(originalLogger) })
	addQueueTestRoom(t, store, dataDir, "queued")
	addQueueTestRoom(t, store, dataDir, "overflow")
	started := make(chan struct{}, 1)
	pipe := pipelineFunc(func(ctx context.Context, _, _, _ string) (
		[]room.TrackInfo, []room.TrackInfo, int, error,
	) {
		started <- struct{}{}
		<-ctx.Done()
		return nil, nil, 0, ctx.Err()
	})
	q := newQueue(1, store, dataDir, nil, pipe)
	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	q.Start(ctx)
	q.Submit("busy")
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("worker did not start")
	}

	q.Submit("queued")
	submitted := make(chan struct{})
	go func() {
		q.Submit("overflow")
		close(submitted)
	}()
	select {
	case <-submitted:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("Submit blocked behind a busy worker")
	}
	require.Eventually(t, func() bool {
		got, err := store.Get(t.Context(), "overflow")
		return err == nil && got.Status == "error" && got.ErrorMessage == "media queue is full"
	}, time.Second, 10*time.Millisecond)
	require.Contains(t, logs.String(), "media queue full")
}

func TestSourcePathRejectsDotAndSymlink(t *testing.T) {
	dataDir := t.TempDir()
	_, _, err := sourcePath(dataDir, ".")
	require.Error(t, err)

	roomDir := filepath.Join(dataDir, "rooms", "safe")
	require.NoError(t, os.MkdirAll(roomDir, 0o755))
	outside := filepath.Join(dataDir, "outside.mkv")
	require.NoError(t, os.WriteFile(outside, []byte("media"), 0o644))
	require.NoError(t, os.Symlink(outside, filepath.Join(roomDir, "original.mkv")))

	_, _, err = sourcePath(dataDir, "safe")
	require.Error(t, err)
}

func TestQueueRejectsSubmissionsAfterCancellation(t *testing.T) {
	store, dataDir := newQueueTestStore(t, "stopped")
	called := make(chan struct{}, 1)
	q := newQueue(1, store, dataDir, nil, pipelineFunc(func(context.Context, string, string, string) (
		[]room.TrackInfo, []room.TrackInfo, int, error,
	) {
		called <- struct{}{}
		return nil, nil, 0, nil
	}))
	ctx, cancel := context.WithCancel(t.Context())
	q.Start(ctx)
	cancel()
	select {
	case <-q.done:
	case <-time.After(time.Second):
		t.Fatal("queue did not stop")
	}

	for range 100 {
		q.Submit("stopped")
	}
	require.Empty(t, q.jobs)
	select {
	case <-called:
		t.Fatal("pipeline ran after cancellation")
	default:
	}
}

func newQueueTestStore(t *testing.T, roomID string) (*room.Store, string) {
	t.Helper()
	mr := miniredis.RunT(t)
	store := room.NewStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}), time.Hour)
	dataDir := t.TempDir()
	addQueueTestRoom(t, store, dataDir, roomID)
	return store, dataDir
}

func addQueueTestRoom(t *testing.T, store *room.Store, dataDir, roomID string) {
	t.Helper()
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: roomID, FileName: "movie.mkv", Status: "uploading", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
	roomDir := filepath.Join(dataDir, "rooms", roomID)
	require.NoError(t, os.MkdirAll(roomDir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(roomDir, "original.mkv"), []byte("media"), 0o644))
}

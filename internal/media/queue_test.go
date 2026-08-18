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

type pipelineFunc func(ctx context.Context, roomID, srcPath, outDir string, skipSubs bool) (
	audio, subs []room.TrackInfo, bitmapSkipped int, err error,
)

func (f pipelineFunc) Run(ctx context.Context, roomID, srcPath, outDir string, skipSubs bool) (
	[]room.TrackInfo, []room.TrackInfo, int, error,
) {
	return f(ctx, roomID, srcPath, outDir, skipSubs)
}

func TestQueueProcessesRoomAndNotifiesReady(t *testing.T) {
	store, dataDir := newQueueTestStore(t, "r1")
	wantAudio := []room.TrackInfo{{Index: 0, Language: "eng"}, {Index: 1, Language: "jpn"}}
	wantSubs := []room.TrackInfo{{Index: 0, Language: "por", Codec: "subrip"}}
	ready := make(chan string, 1)
	type pipelineCall struct{ roomID, srcPath, outDir string }
	calls := make(chan pipelineCall, 1)
	pipe := pipelineFunc(func(ctx context.Context, roomID, srcPath, outDir string, skipSubs bool) (
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

func TestQueueRecoversInterruptedCompleteUpload(t *testing.T) {
	store, dataDir := newQueueTestStore(t, "recover")
	require.NoError(t, store.SetStatus(t.Context(), "recover", "processing"))
	ready := make(chan string, 1)
	q := newQueue(1, store, dataDir, func(roomID string) { ready <- roomID }, pipelineFunc(
		func(context.Context, string, string, string, bool) ([]room.TrackInfo, []room.TrackInfo, int, error) {
			return nil, nil, 0, nil
		},
	))
	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	q.Start(ctx)

	require.NoError(t, q.Recover(ctx))

	select {
	case roomID := <-ready:
		require.Equal(t, "recover", roomID)
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for recovered media job")
	}
	got, err := store.Get(t.Context(), "recover")
	require.NoError(t, err)
	require.Equal(t, "ready", got.Status)
}

func TestQueueKeepsPlayablePreviewReadyDuringFinalRemux(t *testing.T) {
	store, dataDir := newQueueTestStore(t, "preview")
	require.NoError(t, store.SetStatus(t.Context(), "preview", "processing"))
	hlsDir := filepath.Join(dataDir, "rooms", "preview", "hls")
	require.NoError(t, os.MkdirAll(hlsDir, 0o755))
	for _, name := range []string{
		"master.m3u8",
		"preview_stream_0.m3u8",
		"preview_init_0.mp4",
		"preview_stream_0_000000.m4s",
	} {
		require.NoError(t, os.WriteFile(filepath.Join(hlsDir, name), []byte("ready"), 0o644))
	}

	started := make(chan struct{}, 1)
	release := make(chan struct{})
	ready := make(chan string, 2)
	q := newQueue(1, store, dataDir, func(roomID string) { ready <- roomID }, pipelineFunc(
		func(context.Context, string, string, string, bool) ([]room.TrackInfo, []room.TrackInfo, int, error) {
			started <- struct{}{}
			<-release
			return nil, nil, 0, nil
		},
	))
	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	q.Start(ctx)
	q.Submit("preview")

	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for final remux")
	}
	got, err := store.Get(t.Context(), "preview")
	require.NoError(t, err)
	require.Equal(t, "ready", got.Status)
	select {
	case roomID := <-ready:
		require.Equal(t, "preview", roomID)
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for preview ready callback")
	}
	close(release)
}

func TestQueuePreservesClientSubtitles(t *testing.T) {
	store, dataDir := newQueueTestStore(t, "r3")
	clientSubs := []room.TrackInfo{{Index: 0, Language: "eng", Title: "Signs", Codec: "webvtt"}}
	require.NoError(t, store.SetClientSubtitles(t.Context(), "r3", clientSubs))
	wantAudio := []room.TrackInfo{{Index: 0, Language: "eng", Codec: "aac"}}
	ready := make(chan string, 1)
	pipe := pipelineFunc(func(_ context.Context, _, _, _ string, skipSubs bool) (
		[]room.TrackInfo, []room.TrackInfo, int, error,
	) {
		require.True(t, skipSubs)
		return wantAudio, nil, 1, nil
	})
	q := newQueue(1, store, dataDir, func(roomID string) { ready <- roomID }, pipe)
	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	q.Start(ctx)

	q.Submit("r3")

	select {
	case <-ready:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for ready callback")
	}
	got, err := store.Get(t.Context(), "r3")
	require.NoError(t, err)
	require.Equal(t, "ready", got.Status)
	require.Equal(t, wantAudio, got.AudioTracks)
	require.Equal(t, clientSubs, got.SubtitleTracks)
	require.Equal(t, 1, got.BitmapSubsSkipped)
	require.True(t, got.ClientSubs)
}

func TestQueuePersistsPipelineError(t *testing.T) {
	store, dataDir := newQueueTestStore(t, "r2")
	originalLogger := slog.Default()
	var logs bytes.Buffer
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(originalLogger) })
	pipe := pipelineFunc(func(context.Context, string, string, string, bool) (
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
	pipe := pipelineFunc(func(ctx context.Context, _, _, _ string, _ bool) (
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

func TestQueueFullRejectionPersistsAfterCancellation(t *testing.T) {
	store, dataDir := newQueueTestStore(t, "overflow")
	q := newQueue(1, store, dataDir, nil, pipelineFunc(func(context.Context, string, string, string, bool) (
		[]room.TrackInfo, []room.TrackInfo, int, error,
	) {
		return nil, nil, 0, nil
	}))
	ctx, cancel := context.WithCancel(t.Context())
	cancel()

	q.rejectFull(ctx, "overflow")

	got, err := store.Get(t.Context(), "overflow")
	require.NoError(t, err)
	require.Equal(t, "error", got.Status)
	require.Equal(t, "media queue is full", got.ErrorMessage)
}

func TestQueueDeduplicatesActiveRoom(t *testing.T) {
	store, dataDir := newQueueTestStore(t, "duplicate")
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	pipe := pipelineFunc(func(context.Context, string, string, string, bool) (
		[]room.TrackInfo, []room.TrackInfo, int, error,
	) {
		started <- struct{}{}
		<-release
		return nil, nil, 0, nil
	})
	q := newQueue(1, store, dataDir, nil, pipe)
	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	q.Start(ctx)
	q.Submit("duplicate")
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("worker did not start")
	}

	for range 10 {
		q.Submit("duplicate")
	}
	got, err := store.Get(t.Context(), "duplicate")
	require.NoError(t, err)
	require.Equal(t, "processing", got.Status)
	require.Empty(t, got.ErrorMessage)
	require.Empty(t, q.jobs)

	close(release)
	require.Eventually(t, func() bool {
		got, err := store.Get(t.Context(), "duplicate")
		return err == nil && got.Status == "ready"
	}, time.Second, 10*time.Millisecond)
}

func TestQueueCancellationMarksActiveAndBufferedJobs(t *testing.T) {
	store, dataDir := newQueueTestStore(t, "active")
	addQueueTestRoom(t, store, dataDir, "buffered")
	started := make(chan struct{}, 1)
	pipe := pipelineFunc(func(ctx context.Context, _, _, _ string, _ bool) (
		[]room.TrackInfo, []room.TrackInfo, int, error,
	) {
		started <- struct{}{}
		<-ctx.Done()
		return nil, nil, 0, ctx.Err()
	})
	q := newQueue(1, store, dataDir, nil, pipe)
	ctx, cancel := context.WithCancel(t.Context())
	q.Start(ctx)
	q.Submit("active")
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("worker did not start")
	}
	q.Submit("buffered")
	cancel()
	select {
	case <-q.done:
	case <-time.After(time.Second):
		t.Fatal("queue did not stop")
	}

	for _, roomID := range []string{"active", "buffered"} {
		got, err := store.Get(t.Context(), roomID)
		require.NoError(t, err)
		require.Equal(t, "error", got.Status)
		require.Equal(t, "media processing canceled", got.ErrorMessage)
	}
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

	metacharDir := filepath.Join(dataDir, "rooms", "room*")
	require.NoError(t, os.MkdirAll(metacharDir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(metacharDir, "original.mkv"), []byte("media"), 0o644))
	_, _, err = sourcePath(dataDir, "room*")
	require.Error(t, err)
}

func TestQueueRejectsSubmissionsAfterCancellation(t *testing.T) {
	store, dataDir := newQueueTestStore(t, "stopped")
	called := make(chan struct{}, 1)
	q := newQueue(1, store, dataDir, nil, pipelineFunc(func(context.Context, string, string, string, bool) (
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

package media

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/objectstore"
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
	q := newQueue(1, store, dataDir, testPublisher(store), func(roomID string) { ready <- roomID }, nil, pipe)
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
	// The publish must be observable: players reload the unchanged source URL
	// only when the media version moves, and refetch subtitles likewise.
	require.Equal(t, 1, got.MediaVersion)
	require.Equal(t, 1, got.SubsVersion)
}

func TestQueuePublishesSubtitlesBeforeTheFinalMediaUpload(t *testing.T) {
	// The complete subtitles are a few kilobytes and the final media is
	// gigabytes that can take half an hour to upload. A viewer nearing the end
	// of the episode needs the cues now, not when the last segment lands — and
	// a media upload that fails outright must not take the cues down with it.
	store, dataDir := newQueueTestStore(t, "rsubs")
	bucket := objectstore.NewFake()
	bucket.SetFailOn(func(key string) bool { return strings.HasSuffix(key, ".m4s") })
	publisher := NewPublisher(store, bucket, "https://media.example.test")
	wantSubs := []room.TrackInfo{{Index: 0, Language: "por", Codec: "webvtt"}}
	updated := make(chan string, 4)
	pipe := pipelineFunc(func(ctx context.Context, roomID, srcPath, outDir string, skipSubs bool) (
		[]room.TrackInfo, []room.TrackInfo, int, error,
	) {
		hlsDir := filepath.Join(outDir, "hls")
		require.NoError(t, os.MkdirAll(hlsDir, 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(hlsDir, "stream_0.m3u8"),
			[]byte("#EXTM3U\n#EXTINF:2.0,\nstream_0_000.m4s\n#EXT-X-ENDLIST\n"), 0o644))
		require.NoError(t, os.WriteFile(filepath.Join(hlsDir, "stream_0_000.m4s"), []byte("seg"), 0o644))
		subsDir := filepath.Join(outDir, "subs")
		require.NoError(t, os.MkdirAll(subsDir, 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(subsDir, "sub_0_por.vtt"),
			[]byte("WEBVTT\n\n00:23:00.000 --> 00:23:02.000\no final\n"), 0o644))
		return nil, wantSubs, 0, nil
	})
	q := newQueue(1, store, dataDir, publisher, nil,
		func(roomID string) { updated <- roomID }, pipe)
	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	q.Start(ctx)

	q.Submit("rsubs")

	require.Eventually(t, func() bool {
		got, err := store.Get(t.Context(), "rsubs")
		return err == nil && got.Status == "error"
	}, 2*time.Second, 10*time.Millisecond)
	got, err := store.Get(t.Context(), "rsubs")
	require.NoError(t, err)
	require.Equal(t, 1, got.SubsVersion)
	require.Equal(t, wantSubs, got.SubtitleTracks)
	object, ok := bucket.Get("rooms/rsubs/g0/subs/sub_0_por.vtt")
	require.True(t, ok)
	require.Contains(t, string(object.Body), "o final")
	select {
	case roomID := <-updated:
		require.Equal(t, "rsubs", roomID)
	default:
		t.Fatal("the room update that triggers the client refetch never fired")
	}
}

func TestQueueRecoversInterruptedCompleteUpload(t *testing.T) {
	store, dataDir := newQueueTestStore(t, "recover")
	require.NoError(t, store.SetStatus(t.Context(), "recover", "processing"))
	ready := make(chan string, 1)
	q := newQueue(1, store, dataDir, testPublisher(store), func(roomID string) { ready <- roomID }, nil, pipelineFunc(
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
	// A published master playlist is what proves the preview is watchable: its
	// segments have been handed to the bucket and deleted from this disk.
	require.NoError(t, store.SetPlaylists(t.Context(), "preview", map[string]string{
		"master.m3u8": "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\npreview_stream_0.m3u8\n",
	}))

	started := make(chan struct{}, 1)
	release := make(chan struct{})
	ready := make(chan string, 2)
	q := newQueue(1, store, dataDir, testPublisher(store), func(roomID string) { ready <- roomID }, nil, pipelineFunc(
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
	// Keeping the preview visible must not look like a republish, or players
	// would reload right as the final remux begins instead of when it lands.
	require.Equal(t, 0, got.MediaVersion)
	select {
	case roomID := <-ready:
		require.Equal(t, "preview", roomID)
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for preview ready callback")
	}
	close(release)

	select {
	case roomID := <-ready:
		require.Equal(t, "preview", roomID)
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for final ready callback")
	}
	got, err = store.Get(t.Context(), "preview")
	require.NoError(t, err)
	require.Equal(t, 1, got.MediaVersion)
}

func TestQueuePreservesClientSubtitles(t *testing.T) {
	store, dataDir := newQueueTestStore(t, "r3")
	clientSubs := []room.TrackInfo{{Index: 0, Language: "eng", Title: "Signs", Codec: "webvtt"}}
	require.NoError(t, store.SetClientSubtitles(t.Context(), "r3", clientSubs, true))
	wantAudio := []room.TrackInfo{{Index: 0, Language: "eng", Codec: "aac"}}
	ready := make(chan string, 1)
	pipe := pipelineFunc(func(_ context.Context, _, _, _ string, skipSubs bool) (
		[]room.TrackInfo, []room.TrackInfo, int, error,
	) {
		require.True(t, skipSubs)
		return wantAudio, nil, 1, nil
	})
	q := newQueue(1, store, dataDir, testPublisher(store), func(roomID string) { ready <- roomID }, nil, pipe)
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
	q := newQueue(1, store, dataDir, testPublisher(store), nil, nil, pipe)
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
	q := newQueue(1, store, dataDir, testPublisher(store), nil, nil, pipe)
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
	got, err := store.Get(t.Context(), "overflow")
	require.NoError(t, err)
	require.NotEqual(t, "error", got.Status)
	require.NotContains(t, logs.String(), "media queue full")
}

// The queue was as deep as it had workers, so with two of each the fifth room
// to finish uploading was turned away — and being turned away is permanent,
// because Recover never looks at a failed room. A busy encoder is a reason to
// wait, not a reason to lose the room.
func TestQueueHoldsRoomsPastTheWorkerCount(t *testing.T) {
	store, dataDir := newQueueTestStore(t, "busy")
	waiting := make([]string, 0, 12)
	for i := range 12 {
		roomID := fmt.Sprintf("waiting-%02d", i)
		addQueueTestRoom(t, store, dataDir, roomID)
		waiting = append(waiting, roomID)
	}
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	ready := make(chan string, len(waiting)+1)
	pipe := pipelineFunc(func(_ context.Context, roomID, _, _ string, _ bool) (
		[]room.TrackInfo, []room.TrackInfo, int, error,
	) {
		if roomID == "busy" {
			started <- struct{}{}
			<-release
		}
		return nil, nil, 0, nil
	})
	q := newQueue(1, store, dataDir, testPublisher(store), func(roomID string) { ready <- roomID }, nil, pipe)
	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	q.Start(ctx)

	q.Submit("busy")
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("worker did not start")
	}
	for _, roomID := range waiting {
		q.Submit(roomID)
	}

	// Every one of them is behind a worker that cannot take them yet, and none
	// of them is a failure.
	for _, roomID := range waiting {
		got, err := store.Get(t.Context(), roomID)
		require.NoError(t, err)
		require.NotEqualf(t, "error", got.Status, "room %s failed while waiting for a worker", roomID)
	}

	close(release)
	seen := make(map[string]struct{}, len(waiting)+1)
	for range len(waiting) + 1 {
		select {
		case roomID := <-ready:
			seen[roomID] = struct{}{}
		case <-time.After(5 * time.Second):
			t.Fatalf("only %d of %d rooms were processed", len(seen), len(waiting)+1)
		}
	}
	for _, roomID := range waiting {
		require.Contains(t, seen, roomID)
	}
}

// Being turned away is the one failure worth retrying: it says the server was
// busy at an instant, not that there is anything wrong with the media. Recover
// skipped every failed room, so a moment of overload outlived the overload.
func TestRecoverResubmitsARoomTurnedAwayByAFullQueue(t *testing.T) {
	store, dataDir := newQueueTestStore(t, "turned-away")
	addQueueTestRoom(t, store, dataDir, "broken")
	require.NoError(t, store.SetError(t.Context(), "turned-away", publicQueueFullError))
	require.NoError(t, store.SetError(t.Context(), "broken", publicPipelineError))
	ready := make(chan string, 2)
	q := newQueue(1, store, dataDir, testPublisher(store), func(roomID string) { ready <- roomID }, nil,
		pipelineFunc(func(context.Context, string, string, string, bool) (
			[]room.TrackInfo, []room.TrackInfo, int, error,
		) {
			return nil, nil, 0, nil
		}))
	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	q.Start(ctx)

	require.NoError(t, q.Recover(ctx))

	select {
	case roomID := <-ready:
		require.Equal(t, "turned-away", roomID)
	case <-time.After(time.Second):
		t.Fatal("a room turned away by a full queue was never resubmitted")
	}
	got, err := store.Get(t.Context(), "turned-away")
	require.NoError(t, err)
	require.Equal(t, "ready", got.Status)
	// The message went with the retry rather than outliving it.
	require.Empty(t, got.ErrorMessage)

	// Media that could not be processed is left where it is: retrying it would
	// only fail again, once per restart, for as long as the room exists.
	broken, err := store.Get(t.Context(), "broken")
	require.NoError(t, err)
	require.Equal(t, "error", broken.Status)
	select {
	case roomID := <-ready:
		t.Fatalf("unexpected resubmission of %s", roomID)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestQueueFullRejectionPersistsAfterCancellation(t *testing.T) {
	store, dataDir := newQueueTestStore(t, "overflow")
	q := newQueue(1, store, dataDir, testPublisher(store), nil, nil, pipelineFunc(func(context.Context, string, string, string, bool) (
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
	q := newQueue(1, store, dataDir, testPublisher(store), nil, nil, pipe)
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

// What the idle sweep asks before reclaiming a room. It cannot read this off
// the room's status: a room is "ready" from the moment its preview plays and
// stays ready for the whole of the final encode.
func TestQueueReportsWhetherARoomIsStillBeingWorkedOn(t *testing.T) {
	store, dataDir := newQueueTestStore(t, "busy")
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	pipe := pipelineFunc(func(context.Context, string, string, string, bool) (
		[]room.TrackInfo, []room.TrackInfo, int, error,
	) {
		started <- struct{}{}
		<-release
		return nil, nil, 0, nil
	})
	q := newQueue(1, store, dataDir, testPublisher(store), nil, nil, pipe)
	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	q.Start(ctx)
	require.False(t, q.Busy("busy"), "idle before anything is submitted")

	q.Submit("busy")
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("worker did not start")
	}
	require.True(t, q.Busy("busy"))
	require.False(t, q.Busy("some-other-room"))

	close(release)
	require.Eventually(t, func() bool { return !q.Busy("busy") }, time.Second, 10*time.Millisecond)
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
	q := newQueue(1, store, dataDir, testPublisher(store), nil, nil, pipe)
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
	q := newQueue(1, store, dataDir, testPublisher(store), nil, nil, pipelineFunc(func(context.Context, string, string, string, bool) (
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

package sync

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/objectstore"
	"github.com/giulianoo0/ss/internal/room"
)

func TestUnfinishedWork(t *testing.T) {
	now := time.Now()
	tests := []struct {
		name       string
		room       room.Room
		unfinished bool
	}{
		{"protects a preparing room", room.Room{Status: "uploading", CreatedAt: now.Add(-2 * time.Minute)}, true},
		{"gives up on a room stuck preparing", room.Room{Status: "uploading", CreatedAt: now.Add(-11 * time.Minute)}, false},
		{"reclaims a failed room at once", room.Room{Status: "error", CreatedAt: now}, false},
		{"reclaims a room whose plan failed at once", room.Room{Status: "uploading", ErrorMessage: "plan failed", CreatedAt: now}, false},
		{"keeps a room whose source is still arriving", room.Room{
			Status: "ready", CreatedAt: now.Add(-time.Minute),
			Preparation: room.Preparation{SourceBytes: 1000, ReceivedBytes: 400},
		}, true},
		{"releases a finished room", room.Room{
			Status: "ready", CreatedAt: now.Add(-time.Minute),
			Preparation: room.Preparation{SourceBytes: 1000, ReceivedBytes: 1000},
		}, false},
		// A local source lives in the app, which left with everyone else.
		{"releases a room whose source is in the host's app", room.Room{
			Status: room.StatusLocal, LocalSource: true, CreatedAt: now.Add(-time.Minute),
		}, false},
		{"releases a local source halfway up the bucket", room.Room{
			Status: room.StatusUploading, LocalSource: true, CreatedAt: now.Add(-time.Minute),
		}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			require.Equal(t, tt.unfinished, unfinishedWork(&tt.room, now) != "")
		})
	}
}

func TestAbandonedSweepReclaimsAnEmptyRoomNobodyIsWatching(t *testing.T) {
	hub, store, _ := newHubTestServer(t, config.Config{})
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "done", Status: "ready",
		CreatedAt: now.Add(-preparingGrace - time.Minute), ExpiresAt: now.Add(time.Hour),
	}))
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "busy", Status: "ready",
		CreatedAt: now.Add(-time.Minute), ExpiresAt: now.Add(time.Hour),
	}))
	for _, id := range []string{"done", "busy"} {
		require.NoError(t, store.SetIngestProgress(t.Context(), id, 400, 1000))
	}
	var reclaimed []string
	hub.OnRoomReclaimed(func(id string) { reclaimed = append(reclaimed, id) })

	hub.sweepAbandoned()

	_, err := store.Get(t.Context(), "done")
	require.ErrorIs(t, err, room.ErrNotFound)
	_, err = store.Get(t.Context(), "busy")
	require.NoError(t, err)
	require.Contains(t, reclaimed, "done")
	require.NotContains(t, reclaimed, "busy")
}

func TestAbandonedSweepSparesARoomWhoseHostIsStillAtTheDoor(t *testing.T) {
	hub, store, _ := newHubTestServer(t, config.Config{})
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "fresh", Status: room.StatusEmpty, CreatedAt: now.Add(-time.Minute), ExpiresAt: now.Add(time.Hour),
	}))

	hub.sweepAbandoned()

	_, err := store.Get(t.Context(), "fresh")
	require.NoError(t, err)
}

// slowBucket takes its time giving a room's objects back, as R2 does for a
// room with thousands of segments.
type slowBucket struct {
	*objectstore.Fake
	delay time.Duration
}

func (b slowBucket) RemovePrefix(ctx context.Context, prefix string) error {
	select {
	case <-time.After(b.delay):
	case <-ctx.Done():
		return ctx.Err()
	}
	return b.Fake.RemovePrefix(ctx, prefix)
}

func TestAbandonedSweepOutlastsASlowMediaRemoval(t *testing.T) {
	previous := storeTimeout
	storeTimeout = 50 * time.Millisecond
	t.Cleanup(func() { storeTimeout = previous })
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { require.NoError(t, rdb.Close()) })
	store := room.NewStore(rdb, time.Hour)
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "done", Status: "ready", CreatedAt: now.Add(-arrivalGrace - time.Minute), ExpiresAt: now.Add(time.Hour),
	}))
	bucket := slowBucket{Fake: objectstore.NewFake(), delay: 4 * storeTimeout}
	require.NoError(t, bucket.Put(t.Context(), "rooms/done/g0/hls/stream_0_000.m4s", strings.NewReader("x"), 1, "", ""))
	hub := NewHub(store, config.Config{DataDir: t.TempDir()}, bucket)
	t.Cleanup(hub.Close)

	hub.sweepAbandoned()

	_, err := store.Get(t.Context(), "done")
	require.ErrorIs(t, err, room.ErrNotFound)
	require.Empty(t, bucket.Keys())
}

func TestHubTransferHandsTheControlsToTheTarget(t *testing.T) {
	_, _, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	host := dialHubWS(t, server)
	helloHubClient(t, host, "host", 1)
	guest := dialHubWS(t, server)
	helloHubClient(t, guest, "guest", 2)
	require.Equal(t, "members", readHubEvent(t, host).Type)

	require.NoError(t, guest.WriteJSON(Inbound{Type: "transfer", TargetID: "m2"}))
	require.Equal(t, "not_controller", readHubEvent(t, guest).ErrCode)
	require.NoError(t, host.WriteJSON(Inbound{Type: "transfer", TargetID: "m2"}))
	for _, conn := range []*websocket.Conn{host, guest} {
		members := readHubEvent(t, conn)
		require.Equal(t, "members", members.Type)
		require.Equal(t, "m2", members.ControllerID)
	}
}

func TestHubKickTellsTheMemberAndDropsThem(t *testing.T) {
	_, _, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	host := dialHubWS(t, server)
	helloHubClient(t, host, "host", 1)
	guest := dialHubWS(t, server)
	helloHubClient(t, guest, "guest", 2)
	require.Equal(t, "members", readHubEvent(t, host).Type)

	require.NoError(t, host.WriteJSON(Inbound{Type: "kick", TargetID: "m2"}))
	require.Equal(t, "kicked", readHubEvent(t, guest).ErrCode)
	var closed Outbound
	require.Error(t, guest.ReadJSON(&closed), "the socket stayed open behind the kick")
	members := readHubEvent(t, host)
	require.Equal(t, "members", members.Type)
	require.Len(t, members.Members, 1)
}

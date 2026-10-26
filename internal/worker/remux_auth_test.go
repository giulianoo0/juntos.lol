package worker

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/remux"
	"github.com/giulianoo0/ss/internal/room"
)

// Whoever opened the media starts its remux, not only the host: a guest the
// host let open a torrent drives the fleet for it.
func TestTheMediaOwnerStartsTheRemux(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })
	store := room.NewStore(rdb, time.Hour)
	ctx := context.Background()
	now := time.Now()
	require.NoError(t, store.Create(ctx, &room.Room{ID: "r1", Status: room.StatusEmpty, ControllerID: "m1", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}))
	_, generation, err := store.SwapSource(ctx, "r1", "m2", "movie.mkv", "uploading", now)
	require.NoError(t, err)

	registry := NewRegistry(rdb)
	index := 0
	require.NoError(t, registry.SaveJob(ctx, &JobRecord{ID: "t_1", SessionID: "s", WorkerID: "w", State: JobServing, FileIndex: &index, LastSeenAt: now}, time.Hour))
	o := NewRemuxOrchestrator(&Service{Registry: registry, Hub: &Hub{registry: registry}}, store, config.Config{})
	seated := func(memberID, capability string) bool { return capability == "cap" }

	start := func(memberID string) error {
		_, err := o.Start(ctx, "s", "t_1", remux.StartRequest{
			RoomID: "r1", MediaGeneration: generation, RequestID: "q",
			Auth: remux.StartAuth{MemberID: memberID, Capability: "cap"},
		}, seated)
		return err
	}
	require.ErrorIs(t, start("m3"), ErrRemuxDenied)
	require.NotErrorIs(t, start("m2"), ErrRemuxDenied)
	require.NotErrorIs(t, start("m1"), ErrRemuxDenied)
}

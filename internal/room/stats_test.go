package room

import (
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

func TestCensusSplitsLiveRoomsByState(t *testing.T) {
	mr := miniredis.RunT(t)
	store := NewStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}), 5*time.Hour)
	now := time.Now()
	for id, status := range map[string]string{
		"a": "uploading",
		"b": "ready",
		"c": "ready",
	} {
		require.NoError(t, store.Create(t.Context(), &Room{
			ID: id, Status: status, CreatedAt: now, ExpiresAt: now.Add(5 * time.Hour),
		}))
	}

	stats, err := store.Census(t.Context())

	require.NoError(t, err)
	require.Equal(t, 3, stats.Total)
	require.Equal(t, map[string]int{"uploading": 1, "ready": 2}, stats.ByState)
}

func TestCensusDoesNotCountARoomRedisAlreadyExpired(t *testing.T) {
	// The expiry index outlives the records it names: an entry is only
	// removed when a room is deleted, not when its hash times out. Counting
	// the index itself would report rooms that stopped existing hours ago.
	mr := miniredis.RunT(t)
	store := NewStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}), 5*time.Hour)
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &Room{
		ID: "gone", Status: "ready", CreatedAt: now, ExpiresAt: now.Add(5 * time.Hour),
	}))
	mr.Del("room:gone")

	stats, err := store.Census(t.Context())

	require.NoError(t, err)
	require.Equal(t, 0, stats.Total)
	require.Empty(t, stats.ByState)
}

func TestCensusOfAnEmptyStoreIsZeroRatherThanAnError(t *testing.T) {
	mr := miniredis.RunT(t)
	store := NewStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}), 5*time.Hour)

	stats, err := store.Census(t.Context())

	require.NoError(t, err)
	require.Equal(t, 0, stats.Total)
}

package room

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/objectstore"
)

func TestSweeperRemovesExpiredRoom(t *testing.T) {
	mr := miniredis.RunT(t)
	s := NewStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}), time.Hour)
	dir := t.TempDir()
	r := &Room{ID: "old", Status: "ready", ExpiresAt: time.Now().Add(-time.Minute), CreatedAt: time.Now().Add(-2 * time.Hour)}
	require.NoError(t, s.Create(context.Background(), r))
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "rooms", "old"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "rooms", "old", "f"), []byte("x"), 0o644))
	sweepOnce(context.Background(), s, dir)
	_, err := os.Stat(filepath.Join(dir, "rooms", "old"))
	require.True(t, os.IsNotExist(err))
	_, err = s.Get(context.Background(), "old")
	require.Error(t, err)
}

func TestSweeperReclaimsTheExpiredRoomsMedia(t *testing.T) {
	mr := miniredis.RunT(t)
	s := NewStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}), time.Hour)
	dir := t.TempDir()
	bucket := objectstore.NewFake()
	for _, key := range []string{
		"rooms/old/g0/hls/stream_0_000.m4s",
		"rooms/old/g1/subs/sub_0_eng.vtt",
		"rooms/live/g0/hls/stream_0_000.m4s",
	} {
		require.NoError(t, bucket.Put(t.Context(), key, strings.NewReader("x"), 1, "", ""))
	}
	require.NoError(t, s.Create(t.Context(), &Room{
		ID: "old", Status: "ready",
		ExpiresAt: time.Now().Add(-time.Minute), CreatedAt: time.Now().Add(-2 * time.Hour),
	}))

	removed := SweepOnce(t.Context(), s, dir, bucket)

	require.Equal(t, []string{"rooms/live/g0/hls/stream_0_000.m4s"}, bucket.Keys())
	require.Equal(t, []string{"old"}, removed, "the hub hears which rooms went, to tell whoever is still in them")
}

func TestSweeperKeepsTheRoomWhenItsMediaCannotBeReclaimed(t *testing.T) {
	mr := miniredis.RunT(t)
	s := NewStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}), time.Hour)
	dir := t.TempDir()
	bucket := objectstore.NewFake()
	bucket.SetFailOn(func(string) bool { return true })
	require.NoError(t, s.Create(t.Context(), &Room{
		ID: "old", Status: "ready",
		ExpiresAt: time.Now().Add(-time.Minute), CreatedAt: time.Now().Add(-2 * time.Hour),
	}))

	removed := SweepOnce(t.Context(), s, dir, bucket)

	_, err := s.Get(t.Context(), "old")
	require.NoError(t, err, "a room whose media survived it must stay sweepable")
	require.Empty(t, removed)
}

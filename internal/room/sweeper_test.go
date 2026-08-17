package room

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

func TestSweeperRemovesExpiredRoom(t *testing.T) {
	mr := miniredis.RunT(t)
	s := NewStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}), time.Hour)
	dir := t.TempDir()
	r := &Room{ID: "old", Status: "ready", ExpiresAt: time.Now().Add(-time.Minute), CreatedAt: time.Now().Add(-2 * time.Hour)}
	require.NoError(t, s.Create(context.Background(), r))
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "rooms", "old"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "rooms", "old", "f"), []byte("x"), 0o644))
	sweepOnce(context.Background(), s, dir) // extracted tick body, exported for tests as package-private
	_, err := os.Stat(filepath.Join(dir, "rooms", "old"))
	require.True(t, os.IsNotExist(err))
	_, err = s.Get(context.Background(), "old")
	require.Error(t, err)
}

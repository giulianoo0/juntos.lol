package httpapi

import (
	"os"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
)

func TestMain(m *testing.M) {
	gin.SetMode(gin.TestMode)
	os.Exit(m.Run())
}

// newTestStore returns a Store backed by an in-memory miniredis instance.
func newTestStore(t *testing.T) *room.Store {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })
	return room.NewStore(rdb, 5*time.Hour)
}

// testCfg returns a Config with an isolated data dir for handler tests.
func testCfg(t *testing.T) config.Config {
	t.Helper()
	return config.Config{DataDir: t.TempDir(), MaxUploadMB: 100, RoomTTLHours: 5}
}

// newRedis returns a miniredis and a client on it, for tests that need the
// client itself rather than a Store.
func newRedis(t *testing.T) (*miniredis.Miniredis, *redis.Client) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })
	return mr, rdb
}

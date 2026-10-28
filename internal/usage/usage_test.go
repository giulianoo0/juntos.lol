package usage

import (
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/db/dbtest"
)

func counterAt(t *testing.T, now *time.Time) *Counter {
	t.Helper()
	rdb := redis.NewClient(&redis.Options{Addr: miniredis.RunT(t).Addr()})
	c := New(rdb, nil)
	c.now = func() time.Time { return *now }
	return c
}

func TestCounter(t *testing.T) {
	t.Run("a mesma pessoa conta uma vez por dia e de novo no dia seguinte", func(t *testing.T) {
		now := time.Date(2026, 10, 28, 12, 0, 0, 0, zone)
		c := counterAt(t, &now)
		c.Distinct("visitors", "1.2.3.4 firefox")
		c.Distinct("visitors", "1.2.3.4 firefox")
		c.Distinct("visitors", "5.6.7.8 safari")
		day, err := c.Read(t.Context(), "2026-10-28")
		require.NoError(t, err)
		require.Equal(t, int64(2), day["visitors"])

		now = now.Add(24 * time.Hour)
		c.Distinct("visitors", "1.2.3.4 firefox")
		next, err := c.Read(t.Context(), "2026-10-29")
		require.NoError(t, err)
		require.Equal(t, int64(1), next["visitors"])
	})

	t.Run("o dia vira à meia-noite de Brasília, não à de UTC", func(t *testing.T) {
		now := time.Date(2026, 10, 29, 2, 0, 0, 0, time.UTC)
		c := counterAt(t, &now)
		c.Add(Metrics{"visits": 1})
		day, err := c.Read(t.Context(), "2026-10-28")
		require.NoError(t, err)
		require.Equal(t, int64(1), day["visits"])
	})

	t.Run("somas acumulam e o pico guarda o maior", func(t *testing.T) {
		now := time.Date(2026, 10, 28, 12, 0, 0, 0, zone)
		c := counterAt(t, &now)
		c.Add(Metrics{"room_sessions": 1, "room_seconds": 600})
		c.Add(Metrics{"room_sessions": 1, "room_seconds": 300})
		c.Max("peak_members", 7)
		c.Max("peak_members", 3)
		day, err := c.Read(t.Context(), "2026-10-28")
		require.NoError(t, err)
		require.Equal(t, Metrics{"room_sessions": 2, "room_seconds": 900, "peak_members": 7}, day)
	})

	t.Run("contador nulo não conta nem quebra", func(t *testing.T) {
		var c *Counter
		c.Add(Metrics{"visits": 1})
		c.Distinct("visitors", "x")
		c.Max("peak_members", 1)
	})
}

func TestFlush(t *testing.T) {
	t.Run("um Redis que recomeçou não baixa o que o Postgres já guardou", func(t *testing.T) {
		now := time.Date(2026, 10, 28, 12, 0, 0, 0, zone)
		server := miniredis.RunT(t)
		c := New(redis.NewClient(&redis.Options{Addr: server.Addr()}), dbtest.New(t))
		c.now = func() time.Time { return now }
		c.Add(Metrics{"visits": 10})
		c.Flush(t.Context(), false)

		server.FlushAll()
		c.Add(Metrics{"visits": 2, "rooms_created": 1})
		c.Flush(t.Context(), false)

		history, err := c.History(t.Context(), "2026-10-01")
		require.NoError(t, err)
		require.Equal(t, Metrics{"visits": 10, "rooms_created": 1}, history["2026-10-28"])
	})
}

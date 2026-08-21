package room

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/giulianoo0/ss/internal/metrics"
)

// knownStates are the media statuses a room passes through. They are seeded
// into the gauge on every sample so a state that empties reads as zero rather
// than as a series that stopped existing, which on a graph is the difference
// between "nothing is failing" and "the exporter died".
var knownStates = []string{"uploading", "processing", "ready", "error"}

// Stats is a census of the rooms that exist right now.
type Stats struct {
	Total   int
	ByState map[string]int
}

// Census counts live rooms and splits them by media status.
//
// It reads the store rather than keeping a counter in the process, because a
// room can stop existing without anything in this process being told: Redis
// expires the record on its own the moment the TTL elapses. An in-memory
// count would be accurate for about as long as the first room's lifetime.
//
// The expiry index is the room list, and it outlives the records it names —
// entries are removed when a room is deleted, not when its hash expires — so
// an id whose hash is gone is counted as the absence it is.
func (s *Store) Census(ctx context.Context) (Stats, error) {
	ids, err := s.rdb.ZRange(ctx, byExpiryKey, 0, -1).Result()
	if err != nil {
		return Stats{}, err
	}
	stats := Stats{ByState: make(map[string]int, len(knownStates))}
	if len(ids) == 0 {
		return stats, nil
	}
	statuses := make([]*redis.StringCmd, len(ids))
	if _, err := s.rdb.Pipelined(ctx, func(p redis.Pipeliner) error {
		for i, id := range ids {
			statuses[i] = p.HGet(ctx, roomKey(id), "status")
		}
		return nil
	}); err != nil && !errors.Is(err, redis.Nil) {
		return Stats{}, err
	}
	for _, status := range statuses {
		state, err := status.Result()
		if errors.Is(err, redis.Nil) {
			continue
		}
		if err != nil {
			return Stats{}, err
		}
		stats.Total++
		stats.ByState[state]++
	}
	return stats, nil
}

// StartStatsSampler publishes the room census to the metrics gauges every
// interval until ctx is cancelled.
//
// Sampling on a timer rather than collecting on scrape is deliberate: a
// collector that reads Redis would put a network round trip inside every
// scrape, and a Redis that is slow or down would then turn every other series
// on the endpoint into a failed scrape too.
func StartStatsSampler(ctx context.Context, store *Store, interval time.Duration) {
	// Seeded before the first sample, and unconditionally: a Redis that is
	// down makes every sample fail, and a state gauge that never existed
	// draws the same as one that went away.
	for _, state := range knownStates {
		metrics.RoomsByState.WithLabelValues(state)
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	sampleStats(ctx, store)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sampleStats(ctx, store)
		}
	}
}

func sampleStats(ctx context.Context, store *Store) {
	stats, err := store.Census(ctx)
	if err != nil {
		if ctx.Err() == nil {
			slog.WarnContext(ctx, "sample room census failed", "error", err)
		}
		return
	}
	metrics.RoomsActive.Set(float64(stats.Total))
	for _, state := range knownStates {
		metrics.RoomsByState.WithLabelValues(state).Set(float64(stats.ByState[state]))
	}
	for state, count := range stats.ByState {
		metrics.RoomsByState.WithLabelValues(state).Set(float64(count))
	}
}

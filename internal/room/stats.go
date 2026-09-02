package room

import (
	"context"
	"errors"

	"github.com/redis/go-redis/v9"
)

var knownStates = []string{"uploading", "processing", "ready", "error"}

// Stats is a census of the rooms that exist right now.
type Stats struct {
	Total   int
	ByState map[string]int
}

// IDs lists every room the expiry index still names, hash present or not.
func (s *Store) IDs(ctx context.Context) ([]string, error) {
	return s.rdb.ZRange(ctx, byExpiryKey, 0, -1).Result()
}

// Census counts live rooms and splits them by media status. It reads the
// store because Redis expires records without telling this process, and the
// expiry index outlives the hashes it names.
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

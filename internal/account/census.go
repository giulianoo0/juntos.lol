package account

import (
	"context"
	"time"
)

// Census is every account at once, in totals: no one in it is named.
type Census struct {
	Total          int64            `json:"total"`
	Public         int64            `json:"public"`
	SignedIn       int64            `json:"signedIn"`
	Friendships    int64            `json:"friendships"`
	Watches        int64            `json:"watches"`
	WatchedSeconds int64            `json:"watchedSeconds"`
	WatchesByKind  map[string]int64 `json:"watchesByKind"`
	// NewByDay counts accounts opened on each day (Brasília) since the cut.
	NewByDay map[string]int64 `json:"newByDay"`
}

func (s *Store) Census(ctx context.Context, since time.Time) (Census, error) {
	census := Census{WatchesByKind: map[string]int64{}, NewByDay: map[string]int64{}}
	if err := s.pool.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM accounts),
		(SELECT count(*) FROM accounts WHERE visibility = 'public'),
		(SELECT count(DISTINCT account_id) FROM account_sessions WHERE expires_at > now()),
		(SELECT count(*) FROM friendships),
		(SELECT count(*) FROM watches),
		(SELECT coalesce(sum(watched_seconds), 0) FROM accounts)`).Scan(
		&census.Total, &census.Public, &census.SignedIn, &census.Friendships, &census.Watches, &census.WatchedSeconds); err != nil {
		return Census{}, err
	}
	if err := s.counts(ctx, census.WatchesByKind, `SELECT kind, count(*) FROM watches GROUP BY kind`); err != nil {
		return Census{}, err
	}
	if err := s.counts(ctx, census.NewByDay, `SELECT to_char(created_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD'), count(*)
		FROM accounts WHERE created_at >= $1 GROUP BY 1`, since); err != nil {
		return Census{}, err
	}
	return census, nil
}

func (s *Store) counts(ctx context.Context, into map[string]int64, query string, args ...any) error {
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var key string
		var n int64
		if err := rows.Scan(&key, &n); err != nil {
			return err
		}
		into[key] = n
	}
	return rows.Err()
}

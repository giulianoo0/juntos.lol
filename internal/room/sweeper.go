package room

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"time"
)

// StartSweeper ticks every interval and removes expired rooms from disk and
// Redis until ctx is cancelled. This guarantees nothing outlives the room TTL.
func StartSweeper(ctx context.Context, store *Store, dataDir string, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sweepOnce(ctx, store, dataDir)
		}
	}
}

// sweepOnce removes the on-disk directory and Redis keys of every room whose
// ExpiresAt is in the past. Delete already ZREMs rooms:by_expiry.
func sweepOnce(ctx context.Context, store *Store, dataDir string) {
	ids, err := store.ExpiredIDs(ctx, time.Now())
	if err != nil {
		slog.Error("sweeper: list expired rooms", "err", err)
		return
	}
	for _, id := range ids {
		if err := os.RemoveAll(filepath.Join(dataDir, "rooms", id)); err != nil {
			slog.Error("sweeper: remove room dir", "room", id, "err", err)
			continue
		}
		if err := store.Delete(ctx, id); err != nil {
			slog.Error("sweeper: delete room", "room", id, "err", err)
		}
	}
}

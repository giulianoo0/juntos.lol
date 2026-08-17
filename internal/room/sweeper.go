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
			SweepOnce(ctx, store, dataDir)
		}
	}
}

// SweepOnce removes expired room data, including the corresponding tus upload
// bytes and metadata. Delete already ZREMs rooms:by_expiry.
func SweepOnce(ctx context.Context, store *Store, dataDir string) {
	ids, err := store.ExpiredIDs(ctx, time.Now())
	if err != nil {
		slog.Error("sweeper: list expired rooms", "err", err)
		return
	}
	for _, id := range ids {
		uploadID, err := store.UploadID(ctx, id)
		if err != nil {
			slog.Error("sweeper: get reserved upload", "room", id, "err", err)
			continue
		}
		if uploadID != "" {
			incoming := filepath.Join(dataDir, "tus-incoming")
			if err := os.Remove(filepath.Join(incoming, uploadID)); err != nil && !os.IsNotExist(err) {
				slog.Error("sweeper: remove tus upload", "room", id, "upload", uploadID, "err", err)
				continue
			}
			if err := os.Remove(filepath.Join(incoming, uploadID+".info")); err != nil && !os.IsNotExist(err) {
				slog.Error("sweeper: remove tus metadata", "room", id, "upload", uploadID, "err", err)
				continue
			}
		}
		if err := os.RemoveAll(filepath.Join(dataDir, "rooms", id)); err != nil {
			slog.Error("sweeper: remove room dir", "room", id, "err", err)
			continue
		}
		if err := store.Delete(ctx, id); err != nil {
			slog.Error("sweeper: delete room", "room", id, "err", err)
		}
	}
}

// sweepOnce is retained for the package-local tests introduced with Task 3.
func sweepOnce(ctx context.Context, store *Store, dataDir string) {
	SweepOnce(ctx, store, dataDir)
}

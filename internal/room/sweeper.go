package room

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/giulianoo0/ss/internal/objectstore"
)

// MediaStore is the part of the bucket a sweep needs: the ability to give a
// finished room's objects back.
type MediaStore interface {
	RemovePrefix(ctx context.Context, prefix string) error
}

// StartSweeper ticks every interval and removes expired rooms from disk, Redis
// and the bucket until ctx is cancelled. claimIdle is how long a host's browser
// may go quiet mid-remux before its claim on the room is taken back.
func StartSweeper(ctx context.Context, store *Store, dataDir string, bucket MediaStore,
	interval, claimIdle time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			SweepOnce(ctx, store, dataDir, bucket)
			if freed, err := store.ReclaimStaleClientClaims(ctx, claimIdle); err != nil {
				slog.ErrorContext(ctx, "sweeper: reclaim stale client claims", "err", err)
			} else if freed > 0 {
				slog.InfoContext(ctx, "sweeper: reclaimed stale client claims", "count", freed)
			}
		}
	}
}

// SweepOnce removes expired room data — its working directory and the media
// the room published. Delete already ZREMs rooms:by_expiry.
func SweepOnce(ctx context.Context, store *Store, dataDir string, bucket MediaStore) {
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
		if err := removeRoomMedia(ctx, bucket, id); err != nil {
			slog.Error("sweeper: remove room media", "room", id, "err", err)
			continue
		}
		if err := store.Delete(ctx, id); err != nil {
			slog.Error("sweeper: delete room", "room", id, "err", err)
			continue
		}
		slog.InfoContext(ctx, "sweeper: removed expired room", "room", id)
	}
}

func sweepOnce(ctx context.Context, store *Store, dataDir string) {
	SweepOnce(ctx, store, dataDir, nil)
}

// PurgeData removes everything a room accumulated — working directory and
// published media — while leaving the record in place, so the error that
// killed the room stays readable. Every step is attempted even when one fails.
func PurgeData(ctx context.Context, store *Store, dataDir string, bucket MediaStore, id string) error {
	var errs []error
	claim, err := store.UploadID(ctx, id)
	if err != nil && !errors.Is(err, ErrNotFound) {
		errs = append(errs, fmt.Errorf("get client claim: %w", err))
	}
	if claim != "" {
		if err := store.ReleaseUpload(ctx, id, claim); err != nil {
			errs = append(errs, err)
		}
	}
	if err := os.RemoveAll(filepath.Join(dataDir, "rooms", id)); err != nil {
		errs = append(errs, fmt.Errorf("remove room dir: %w", err))
	}
	if err := removeRoomMedia(ctx, bucket, id); err != nil {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

func removeRoomMedia(ctx context.Context, bucket MediaStore, id string) error {
	if bucket == nil {
		return nil
	}
	return bucket.RemovePrefix(ctx, objectstore.RoomPrefix(id))
}

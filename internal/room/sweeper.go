package room

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/giulianoo0/ss/internal/metrics"
	"github.com/giulianoo0/ss/internal/objectstore"
)

// MediaStore is the part of the bucket a sweep needs: the ability to give a
// finished room's objects back.
type MediaStore interface {
	RemovePrefix(ctx context.Context, prefix string) error
}

// StartSweeper ticks every interval and removes expired rooms from disk, Redis
// and the bucket until ctx is cancelled. This guarantees nothing outlives the
// room TTL. claimIdle is how long a host's browser may go quiet mid-remux
// before its claim on the room is taken back.
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
//
// The bucket's lifecycle rule remains the backstop, but it is measured from
// when each object was written, so media left here outlives the room that
// owned it by most of a lifecycle window while nothing can reach it: the
// playlists naming it went with the room.
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
		// Before the room record goes: it is the only thing that still names
		// these objects, so dropping it first would strand them until the
		// bucket's own rule caught up.
		if err := removeRoomMedia(ctx, bucket, id); err != nil {
			slog.Error("sweeper: remove room media", "room", id, "err", err)
			continue
		}
		if err := store.Delete(ctx, id); err != nil {
			slog.Error("sweeper: delete room", "room", id, "err", err)
			continue
		}
		metrics.RoomsReclaimed.WithLabelValues(metrics.ReclaimExpired).Inc()
		// Removing a room is the one thing here that a viewer notices
		// immediately and cannot undo, and it used to happen in silence: a
		// room that vanished left nothing behind saying it was the sweeper
		// that took it, or when it was due to go.
		slog.InfoContext(ctx, "sweeper: removed expired room", "room", id)
	}
}

// sweepOnce is retained for the package-local tests introduced with Task 3.
func sweepOnce(ctx context.Context, store *Store, dataDir string) {
	SweepOnce(ctx, store, dataDir, nil)
}

// PurgeData removes everything a room has accumulated — its working directory
// and the media it published — while leaving the record itself in place: the
// error that killed the room stays readable until it expires, but not one
// byte of a source that will never play stays paid for.
//
// The claim is released before the files go, so a new remux cannot start
// against the room mid-purge. Every step is attempted even when an earlier
// one fails: a purge that gives up half way keeps paying for what it left.
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

// removeRoomMedia gives a room's published objects back to the bucket.
func removeRoomMedia(ctx context.Context, bucket MediaStore, id string) error {
	if bucket == nil {
		return nil
	}
	return bucket.RemovePrefix(ctx, objectstore.RoomPrefix(id))
}

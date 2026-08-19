package room

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// StartSweeper ticks every interval and removes expired rooms from disk and
// Redis until ctx is cancelled. This guarantees nothing outlives the room TTL.
func StartSweeper(ctx context.Context, store *Store, dataDir string, interval, uploadIdle time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			SweepOnce(ctx, store, dataDir)
			SweepStaleUploads(ctx, store, dataDir, uploadIdle)
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

// tusInfo is the part of the sidecar tusd writes next to an upload that
// identifies which room the bytes belong to.
type tusInfo struct {
	MetaData map[string]string `json:"MetaData"`
}

// SweepStaleUploads reclaims uploads nobody is feeding any more.
//
// A tus upload survives the tab that started it, which is the point: closing
// it by accident should not lose the transfer. But an upload nobody returns to
// otherwise occupies its bytes until the room's whole TTL elapses, and its
// room sits in "uploading" forever showing viewers a preparing screen that
// will never finish. Anything untouched for idleFor is therefore released, its
// room marked failed, and its bytes returned.
//
// The data file's modification time is the activity signal: the store writes
// to it as each chunk lands, so it is exactly "when we last heard from the
// uploader" with no bookkeeping of its own to drift.
func SweepStaleUploads(ctx context.Context, store *Store, dataDir string, idleFor time.Duration) {
	incoming := filepath.Join(dataDir, "tus-incoming")
	entries, err := os.ReadDir(incoming)
	if err != nil {
		if !os.IsNotExist(err) {
			slog.ErrorContext(ctx, "sweeper: read tus uploads", "err", err)
		}
		return
	}

	cutoff := time.Now().Add(-idleFor)
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || strings.HasSuffix(name, ".info") {
			continue
		}
		info, err := entry.Info()
		if err != nil || info.ModTime().After(cutoff) {
			continue
		}

		roomID := uploadRoomID(filepath.Join(incoming, name+".info"))
		if roomID != "" {
			if err := store.ReleaseUpload(ctx, roomID, name); err != nil {
				slog.ErrorContext(ctx, "sweeper: release stale upload", "room", roomID, "err", err)
			}
			// The room can never reach ready now, so stop it presenting as a
			// transfer still in progress.
			if err := store.SetError(ctx, roomID, "upload abandoned"); err != nil && !errors.Is(err, ErrNotFound) {
				slog.ErrorContext(ctx, "sweeper: mark abandoned upload", "room", roomID, "err", err)
			}
		}
		slog.InfoContext(ctx, "sweeper: reclaiming abandoned upload",
			"room", roomID, "upload", name, "idle_for", time.Since(info.ModTime()).Round(time.Second))
		for _, path := range []string{filepath.Join(incoming, name), filepath.Join(incoming, name+".info")} {
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				slog.ErrorContext(ctx, "sweeper: remove stale upload", "path", path, "err", err)
			}
		}
	}
}

func uploadRoomID(infoPath string) string {
	data, err := os.ReadFile(infoPath)
	if err != nil {
		return ""
	}
	var info tusInfo
	if err := json.Unmarshal(data, &info); err != nil {
		return ""
	}
	return info.MetaData["roomID"]
}

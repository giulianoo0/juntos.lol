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

// PreviewGracePeriod is how long the superseded preview files are kept after
// the final media replaces them. A player that joined during the preview may
// still be mid-fetch of one of its segments, and the final master does not
// reach every client at the same instant.
const PreviewGracePeriod = 5 * time.Minute

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
			SweepSupersededPreviews(ctx, dataDir, PreviewGracePeriod)
		}
	}
}

// SweepSupersededPreviews reclaims the preview segments of rooms whose final
// media has been published for longer than grace.
//
// The preview is a second, complete copy of the video in two-second segments,
// and it is dead weight the moment the final playlists take over — on a 96 GB
// disk it is the difference between four concurrent rooms and six. Deleting it
// at publish time would 404 whoever was still reading it, hence the grace.
//
// Living on the sweeper rather than on a timer in the publishing path is what
// makes it survive a restart: a process that died between publishing and
// cleaning up would otherwise leave the copy behind for the room's whole life.
func SweepSupersededPreviews(ctx context.Context, dataDir string, grace time.Duration) {
	rooms, err := os.ReadDir(filepath.Join(dataDir, "rooms"))
	if err != nil {
		if !os.IsNotExist(err) {
			slog.ErrorContext(ctx, "sweeper: read rooms for preview cleanup", "err", err)
		}
		return
	}

	cutoff := time.Now().Add(-grace)
	for _, entry := range rooms {
		if !entry.IsDir() {
			continue
		}
		hlsDir := filepath.Join(dataDir, "rooms", entry.Name(), "hls")
		// The final remux renames its master into place, so this file's
		// modification time is exactly when the preview stopped being needed.
		master, err := os.Stat(filepath.Join(hlsDir, "master.m3u8"))
		if err != nil || master.ModTime().After(cutoff) {
			continue
		}
		if !finalMediaPublished(hlsDir) {
			continue
		}
		reclaimed := removePreviewFiles(ctx, hlsDir, entry.Name())
		if reclaimed > 0 {
			slog.InfoContext(ctx, "sweeper: reclaimed superseded preview",
				"room", entry.Name(), "bytes", reclaimed)
		}
	}
}

// finalMediaPublished reports whether the VOD remux has taken over, so a room
// still serving only its preview never has that preview taken away.
func finalMediaPublished(hlsDir string) bool {
	matches, err := filepath.Glob(filepath.Join(hlsDir, "stream_*.m3u8"))
	return err == nil && len(matches) > 0
}

func removePreviewFiles(ctx context.Context, hlsDir, roomID string) int64 {
	matches, err := filepath.Glob(filepath.Join(hlsDir, "preview_*"))
	if err != nil {
		slog.ErrorContext(ctx, "sweeper: list preview files", "room", roomID, "err", err)
		return 0
	}
	var reclaimed int64
	for _, match := range matches {
		if info, err := os.Stat(match); err == nil {
			reclaimed += info.Size()
		}
		if err := os.Remove(match); err != nil && !os.IsNotExist(err) {
			slog.ErrorContext(ctx, "sweeper: remove preview file", "room", roomID, "path", match, "err", err)
		}
	}
	return reclaimed
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
			continue
		}
		// Removing a room is the one thing here that a viewer notices
		// immediately and cannot undo, and it used to happen in silence: a
		// room that vanished left nothing behind saying it was the sweeper
		// that took it, or when it was due to go.
		slog.InfoContext(ctx, "sweeper: removed expired room", "room", id)
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

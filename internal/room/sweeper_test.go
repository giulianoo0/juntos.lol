package room

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

func TestSweeperRemovesExpiredRoom(t *testing.T) {
	mr := miniredis.RunT(t)
	s := NewStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}), time.Hour)
	dir := t.TempDir()
	r := &Room{ID: "old", Status: "ready", ExpiresAt: time.Now().Add(-time.Minute), CreatedAt: time.Now().Add(-2 * time.Hour)}
	require.NoError(t, s.Create(context.Background(), r))
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "rooms", "old"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "rooms", "old", "f"), []byte("x"), 0o644))
	sweepOnce(context.Background(), s, dir) // extracted tick body, exported for tests as package-private
	_, err := os.Stat(filepath.Join(dir, "rooms", "old"))
	require.True(t, os.IsNotExist(err))
	_, err = s.Get(context.Background(), "old")
	require.Error(t, err)
}

// stagedUpload writes an upload the way tusd's filestore lays one out, with
// the sidecar naming the room it belongs to.
func stagedUpload(t *testing.T, dataDir, uploadID, roomID string, idle time.Duration) string {
	t.Helper()
	incoming := filepath.Join(dataDir, "tus-incoming")
	require.NoError(t, os.MkdirAll(incoming, 0o755))
	data := filepath.Join(incoming, uploadID)
	require.NoError(t, os.WriteFile(data, []byte("partial bytes"), 0o644))
	require.NoError(t, os.WriteFile(data+".info",
		[]byte(`{"ID":"`+uploadID+`","MetaData":{"filename":"movie.mkv","roomID":"`+roomID+`"}}`), 0o644))
	stamp := time.Now().Add(-idle)
	require.NoError(t, os.Chtimes(data, stamp, stamp))
	return data
}

func uploadingRoom(t *testing.T, s *Store, id string) {
	t.Helper()
	now := time.Now()
	require.NoError(t, s.Create(context.Background(), &Room{
		ID: id, Status: "uploading", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
}

func TestSweepStaleUploadsKeepsOneStillBeingFed(t *testing.T) {
	mr := miniredis.RunT(t)
	s := NewStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}), time.Hour)
	dir := t.TempDir()
	uploadingRoom(t, s, "live")
	data := stagedUpload(t, dir, "upload-live", "live", time.Minute)
	require.NoError(t, s.ReserveUpload(context.Background(), "live", "upload-live", time.Now()))

	SweepStaleUploads(context.Background(), s, dir, 10*time.Minute)

	// A transfer that sent bytes a minute ago is simply in progress.
	require.FileExists(t, data)
	require.FileExists(t, data+".info")
	got, err := s.Get(context.Background(), "live")
	require.NoError(t, err)
	require.Equal(t, "uploading", got.Status)
}

func TestSweepStaleUploadsReclaimsAnAbandonedOne(t *testing.T) {
	mr := miniredis.RunT(t)
	s := NewStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}), time.Hour)
	dir := t.TempDir()
	uploadingRoom(t, s, "gone")
	data := stagedUpload(t, dir, "upload-gone", "gone", 30*time.Minute)
	require.NoError(t, s.ReserveUpload(context.Background(), "gone", "upload-gone", time.Now()))

	SweepStaleUploads(context.Background(), s, dir, 10*time.Minute)

	require.NoFileExists(t, data)
	require.NoFileExists(t, data+".info")
	// The room can never finish, so it must stop presenting as in progress.
	got, err := s.Get(context.Background(), "gone")
	require.NoError(t, err)
	require.Equal(t, "error", got.Status)
	require.Equal(t, "upload abandoned", got.ErrorMessage)
	// The reservation is released, so the room could accept a fresh upload.
	reserved, err := s.UploadID(context.Background(), "gone")
	require.NoError(t, err)
	require.Empty(t, reserved)
}

func TestSweepStaleUploadsReclaimsBytesWithoutASidecar(t *testing.T) {
	mr := miniredis.RunT(t)
	s := NewStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}), time.Hour)
	dir := t.TempDir()
	incoming := filepath.Join(dir, "tus-incoming")
	require.NoError(t, os.MkdirAll(incoming, 0o755))
	orphan := filepath.Join(incoming, "no-sidecar")
	require.NoError(t, os.WriteFile(orphan, []byte("bytes"), 0o644))
	stamp := time.Now().Add(-time.Hour)
	require.NoError(t, os.Chtimes(orphan, stamp, stamp))

	SweepStaleUploads(context.Background(), s, dir, 10*time.Minute)

	// Nothing identifies the room, but the disk is still owed the space.
	require.NoFileExists(t, orphan)
}

func TestSweepStaleUploadsIgnoresASidecarOnItsOwn(t *testing.T) {
	mr := miniredis.RunT(t)
	s := NewStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}), time.Hour)
	dir := t.TempDir()
	uploadingRoom(t, s, "fresh")
	// The sidecar is old while the data file is current: only the data file
	// says when the uploader was last heard from.
	data := stagedUpload(t, dir, "upload-fresh", "fresh", 0)
	stamp := time.Now().Add(-time.Hour)
	require.NoError(t, os.Chtimes(data+".info", stamp, stamp))

	SweepStaleUploads(context.Background(), s, dir, 10*time.Minute)

	require.FileExists(t, data)
	require.FileExists(t, data+".info")
}

func TestSweepSupersededPreviewsReclaimsAfterTheGrace(t *testing.T) {
	dataDir := t.TempDir()
	hlsDir := filepath.Join(dataDir, "rooms", "room1", "hls")
	require.NoError(t, os.MkdirAll(hlsDir, 0o755))

	// A finished room: the final VOD playlists are in place and the preview
	// copy beside them is dead weight.
	for _, name := range []string{
		"master.m3u8", "stream_0.m3u8", "stream_0_000.m4s",
		"preview_stream_0.m3u8", "preview_stream_0_000000.m4s", "preview_init_0.mp4",
	} {
		require.NoError(t, os.WriteFile(filepath.Join(hlsDir, name), []byte("x"), 0o644))
	}
	old := time.Now().Add(-10 * time.Minute)
	require.NoError(t, os.Chtimes(filepath.Join(hlsDir, "master.m3u8"), old, old))

	SweepSupersededPreviews(context.Background(), dataDir, 5*time.Minute)

	previews, err := filepath.Glob(filepath.Join(hlsDir, "preview_*"))
	require.NoError(t, err)
	require.Empty(t, previews, "preview files survived the grace period")
	// The final media is untouched.
	require.FileExists(t, filepath.Join(hlsDir, "stream_0_000.m4s"))
	require.FileExists(t, filepath.Join(hlsDir, "master.m3u8"))
}

func TestSweepSupersededPreviewsWaitsOutTheGrace(t *testing.T) {
	dataDir := t.TempDir()
	hlsDir := filepath.Join(dataDir, "rooms", "room1", "hls")
	require.NoError(t, os.MkdirAll(hlsDir, 0o755))
	for _, name := range []string{"master.m3u8", "stream_0.m3u8", "preview_stream_0_000000.m4s"} {
		require.NoError(t, os.WriteFile(filepath.Join(hlsDir, name), []byte("x"), 0o644))
	}

	// Published seconds ago: someone may still be reading a preview segment.
	SweepSupersededPreviews(context.Background(), dataDir, 5*time.Minute)

	require.FileExists(t, filepath.Join(hlsDir, "preview_stream_0_000000.m4s"))
}

func TestSweepSupersededPreviewsLeavesARoomStillOnItsPreview(t *testing.T) {
	dataDir := t.TempDir()
	hlsDir := filepath.Join(dataDir, "rooms", "room1", "hls")
	require.NoError(t, os.MkdirAll(hlsDir, 0o755))
	// Only the preview exists: the download is still running, and taking these
	// away would stop the very playback they are serving.
	for _, name := range []string{"master.m3u8", "preview_stream_0.m3u8", "preview_stream_0_000000.m4s"} {
		require.NoError(t, os.WriteFile(filepath.Join(hlsDir, name), []byte("x"), 0o644))
	}
	old := time.Now().Add(-30 * time.Minute)
	require.NoError(t, os.Chtimes(filepath.Join(hlsDir, "master.m3u8"), old, old))

	SweepSupersededPreviews(context.Background(), dataDir, 5*time.Minute)

	require.FileExists(t, filepath.Join(hlsDir, "preview_stream_0_000000.m4s"))
}

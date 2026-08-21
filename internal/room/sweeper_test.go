package room

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/objectstore"
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

func TestSweeperReclaimsTheExpiredRoomsMedia(t *testing.T) {
	// The bucket's lifecycle rule is a backstop measured from when each object
	// was written, so media the sweeper leaves behind outlives the room that
	// owned it by most of a lifecycle window. Nothing can reach it by then:
	// the playlists pointing at it went with the room.
	mr := miniredis.RunT(t)
	s := NewStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}), time.Hour)
	dir := t.TempDir()
	bucket := objectstore.NewFake()
	for _, key := range []string{
		"rooms/old/g0/hls/stream_0_000.m4s",
		"rooms/old/g1/subs/sub_0_eng.vtt",
		"rooms/live/g0/hls/stream_0_000.m4s",
	} {
		require.NoError(t, bucket.Put(t.Context(), key, strings.NewReader("x"), 1, "", ""))
	}
	require.NoError(t, s.Create(t.Context(), &Room{
		ID: "old", Status: "ready",
		ExpiresAt: time.Now().Add(-time.Minute), CreatedAt: time.Now().Add(-2 * time.Hour),
	}))

	SweepOnce(t.Context(), s, dir, bucket)

	require.Equal(t, []string{"rooms/live/g0/hls/stream_0_000.m4s"}, bucket.Keys())
}

func TestSweeperKeepsTheRoomWhenItsMediaCannotBeReclaimed(t *testing.T) {
	// Dropping the room first would strand its objects with nothing left
	// naming them, and the only record that they need reclaiming is the room
	// itself. Better to keep both and retry on the next tick.
	mr := miniredis.RunT(t)
	s := NewStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}), time.Hour)
	dir := t.TempDir()
	bucket := objectstore.NewFake()
	bucket.SetFailOn(func(string) bool { return true })
	require.NoError(t, s.Create(t.Context(), &Room{
		ID: "old", Status: "ready",
		ExpiresAt: time.Now().Add(-time.Minute), CreatedAt: time.Now().Add(-2 * time.Hour),
	}))

	SweepOnce(t.Context(), s, dir, bucket)

	_, err := s.Get(t.Context(), "old")
	require.NoError(t, err, "a room whose media survived it must stay sweepable")
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

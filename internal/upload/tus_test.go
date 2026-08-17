package upload

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
	"github.com/tus/tusd/v2/pkg/filestore"
	tusd "github.com/tus/tusd/v2/pkg/handler"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
)

func testSetup(t *testing.T) (*room.Store, config.Config) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })
	return room.NewStore(rdb, 5*time.Hour),
		config.Config{DataDir: t.TempDir(), MaxUploadMB: 100, RoomTTLHours: 5}
}

func createRoom(t *testing.T, s *room.Store, id, status string) {
	t.Helper()
	r := &room.Room{ID: id, FileName: "movie.mkv", Status: status,
		ControllerID: "m1", CreatedAt: time.Now(), ExpiresAt: time.Now().Add(5 * time.Hour)}
	require.NoError(t, s.Create(context.Background(), r))
}

func metadataHeader(meta map[string]string) string {
	pairs := make([]string, 0, len(meta))
	for k, v := range meta {
		pairs = append(pairs, k+" "+base64.StdEncoding.EncodeToString([]byte(v)))
	}
	return strings.Join(pairs, ",")
}

func TestPreCreateRejectsUnknownRoom(t *testing.T) {
	s, cfg := testSetup(t)
	h, err := NewTusHandler(cfg, s, func(string) {})
	require.NoError(t, err)

	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/upload/", nil)
	req.Header.Set("Tus-Resumable", "1.0.0")
	req.Header.Set("Upload-Length", "10")
	req.Header.Set("Upload-Metadata", metadataHeader(map[string]string{
		"roomID":   "missing1",
		"filename": "movie.mkv",
	}))
	http.StripPrefix("/api/upload", h).ServeHTTP(w, req)
	require.Equal(t, http.StatusForbidden, w.Code)
}

func TestPreCreateRejectsRoomNotUploading(t *testing.T) {
	s, cfg := testSetup(t)
	createRoom(t, s, "room1234", "ready")
	h, err := NewTusHandler(cfg, s, func(string) {})
	require.NoError(t, err)

	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/upload/", nil)
	req.Header.Set("Tus-Resumable", "1.0.0")
	req.Header.Set("Upload-Length", "10")
	req.Header.Set("Upload-Metadata", metadataHeader(map[string]string{
		"roomID":   "room1234",
		"filename": "movie.mkv",
	}))
	http.StripPrefix("/api/upload", h).ServeHTTP(w, req)
	require.Equal(t, http.StatusForbidden, w.Code)
}

func TestPreCreateAcceptsUploadingRoom(t *testing.T) {
	s, cfg := testSetup(t)
	createRoom(t, s, "room1234", "uploading")
	h, err := NewTusHandler(cfg, s, func(string) {})
	require.NoError(t, err)

	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/upload/", nil)
	req.Header.Set("Tus-Resumable", "1.0.0")
	req.Header.Set("Upload-Length", "10")
	req.Header.Set("Upload-Metadata", metadataHeader(map[string]string{
		"roomID":   "room1234",
		"filename": "movie.mkv",
	}))
	http.StripPrefix("/api/upload", h).ServeHTTP(w, req)
	require.Equal(t, http.StatusCreated, w.Code)
}

func TestCompleteUploadMovesFile(t *testing.T) {
	s, cfg := testSetup(t)
	createRoom(t, s, "room1234", "uploading")

	done := make(chan string, 1)
	h, err := NewTusHandler(cfg, s, func(roomID string) { done <- roomID })
	require.NoError(t, err)
	th := h.(*tusd.Handler)

	src := filepath.Join(cfg.DataDir, "tus-incoming", "upload1")
	require.NoError(t, os.MkdirAll(filepath.Dir(src), 0o755))
	require.NoError(t, os.WriteFile(src, []byte("fake video bytes"), 0o644))

	th.CompleteUploads <- tusd.HookEvent{Upload: tusd.FileInfo{
		ID:       "upload1",
		MetaData: tusd.MetaData{"roomID": "room1234", "filename": "movie.mkv"},
		Storage:  map[string]string{filestore.StorageKeyPath: src},
	}}

	select {
	case roomID := <-done:
		require.Equal(t, "room1234", roomID)
	case <-time.After(2 * time.Second):
		t.Fatal("onComplete not called")
	}

	got, err := os.ReadFile(filepath.Join(cfg.DataDir, "rooms", "room1234", "original.mkv"))
	require.NoError(t, err)
	require.Equal(t, "fake video bytes", string(got))
}

func TestTerminatedUploadRemovesRoomDir(t *testing.T) {
	s, cfg := testSetup(t)
	createRoom(t, s, "room1234", "uploading")

	h, err := NewTusHandler(cfg, s, func(string) {})
	require.NoError(t, err)
	th := h.(*tusd.Handler)

	roomDir := filepath.Join(cfg.DataDir, "rooms", "room1234")
	require.NoError(t, os.MkdirAll(roomDir, 0o755))

	th.TerminatedUploads <- tusd.HookEvent{Upload: tusd.FileInfo{
		ID:       "upload1",
		MetaData: tusd.MetaData{"roomID": "room1234"},
	}}

	require.Eventually(t, func() bool {
		_, err := os.Stat(roomDir)
		return os.IsNotExist(err)
	}, 2*time.Second, 10*time.Millisecond)
}

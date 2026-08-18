package upload

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"

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
	h, err := NewTusHandler(cfg, s, func(string) {}, nil, nil)
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
	h, err := NewTusHandler(cfg, s, func(string) {}, nil, nil)
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
	h, err := NewTusHandler(cfg, s, func(string) {}, nil, nil)
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

func TestPreCreateUsesForwardedHTTPSLocation(t *testing.T) {
	s, cfg := testSetup(t)
	createRoom(t, s, "room1234", "uploading")
	h, err := NewTusHandler(cfg, s, func(string) {}, nil, nil)
	require.NoError(t, err)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "http://app.internal/api/upload/", nil)
	req.Host = "ss.example.test"
	req.Header.Set("Tus-Resumable", "1.0.0")
	req.Header.Set("Upload-Length", "10")
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("Upload-Metadata", metadataHeader(map[string]string{
		"roomID":   "room1234",
		"filename": "movie.mkv",
	}))

	http.StripPrefix("/api/upload", h).ServeHTTP(w, req)

	require.Equal(t, http.StatusCreated, w.Code)
	require.Regexp(t, `^https://ss\.example\.test/api/upload/`, w.Header().Get("Location"))
}

func TestPreCreateRejectsSecondUploadForRoom(t *testing.T) {
	s, cfg := testSetup(t)
	createRoom(t, s, "room1234", "uploading")

	h, err := NewTusHandler(cfg, s, func(string) {}, nil, nil)
	require.NoError(t, err)
	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/api/upload/", nil)
		req.Header.Set("Tus-Resumable", "1.0.0")
		req.Header.Set("Upload-Length", "10")
		req.Header.Set("Upload-Metadata", metadataHeader(map[string]string{
			"roomID":   "room1234",
			"filename": "movie.mkv",
		}))
		http.StripPrefix("/api/upload", h).ServeHTTP(w, req)
		if i == 0 {
			require.Equal(t, http.StatusCreated, w.Code)
			continue
		}
		require.Equal(t, http.StatusConflict, w.Code)
	}
}

func TestCompleteUploadMovesFile(t *testing.T) {
	s, cfg := testSetup(t)
	createRoom(t, s, "room1234", "uploading")

	done := make(chan string, 1)
	h, err := NewTusHandler(cfg, s, func(roomID string) { done <- roomID }, nil, nil)
	require.NoError(t, err)
	h = http.StripPrefix("/api/upload", h)

	create := httptest.NewRecorder()
	createReq := httptest.NewRequest("POST", "/api/upload/", nil)
	createReq.Header.Set("Tus-Resumable", "1.0.0")
	createReq.Header.Set("Upload-Length", "16")
	createReq.Header.Set("Upload-Metadata", metadataHeader(map[string]string{
		"roomID":   "room1234",
		"filename": "movie.mkv",
	}))
	h.ServeHTTP(create, createReq)
	require.Equal(t, http.StatusCreated, create.Code)

	u, err := url.Parse(create.Header().Get("Location"))
	require.NoError(t, err)
	uploadID := filepath.Base(u.Path)
	require.NotEmpty(t, uploadID)
	require.FileExists(t, filepath.Join(cfg.DataDir, "tus-incoming", uploadID))
	require.FileExists(t, filepath.Join(cfg.DataDir, "tus-incoming", uploadID+".info"))

	patch := httptest.NewRecorder()
	patchReq := httptest.NewRequest("PATCH", u.Path, strings.NewReader("fake video bytes"))
	patchReq.Header.Set("Tus-Resumable", "1.0.0")
	patchReq.Header.Set("Content-Type", "application/offset+octet-stream")
	patchReq.Header.Set("Upload-Offset", "0")
	h.ServeHTTP(patch, patchReq)
	require.Equal(t, http.StatusNoContent, patch.Code)

	select {
	case roomID := <-done:
		require.Equal(t, "room1234", roomID)
	case <-time.After(2 * time.Second):
		t.Fatal("onComplete not called")
	}

	got, err := os.ReadFile(filepath.Join(cfg.DataDir, "rooms", "room1234", "original.mkv"))
	require.NoError(t, err)
	require.Equal(t, "fake video bytes", string(got))
	require.NoFileExists(t, filepath.Join(cfg.DataDir, "tus-incoming", uploadID))
	require.NoFileExists(t, filepath.Join(cfg.DataDir, "tus-incoming", uploadID+".info"))
}

func TestUploadProgressKeepsOfferingStreamStart(t *testing.T) {
	s, cfg := testSetup(t)
	createRoom(t, s, "room1234", "uploading")

	type streamStart struct{ roomID, srcPath string }
	started := make(chan streamStart, 4)
	h, err := NewTusHandler(cfg, s, nil,
		func(roomID, srcPath string) { started <- streamStart{roomID, srcPath} }, nil)
	require.NoError(t, err)
	h = http.StripPrefix("/api/upload", h)

	create := httptest.NewRecorder()
	createReq := httptest.NewRequest("POST", "/api/upload/", nil)
	createReq.Header.Set("Tus-Resumable", "1.0.0")
	createReq.Header.Set("Upload-Length", "48")
	createReq.Header.Set("Upload-Metadata", metadataHeader(map[string]string{
		"roomID":   "room1234",
		"filename": "movie.mkv",
	}))
	h.ServeHTTP(create, createReq)
	require.Equal(t, http.StatusCreated, create.Code)

	u, err := url.Parse(create.Header().Get("Location"))
	require.NoError(t, err)
	uploadID := filepath.Base(u.Path)

	patch := func(offset, body string) {
		t.Helper()
		w := httptest.NewRecorder()
		req := httptest.NewRequest("PATCH", u.Path, strings.NewReader(body))
		req.Header.Set("Tus-Resumable", "1.0.0")
		req.Header.Set("Content-Type", "application/offset+octet-stream")
		req.Header.Set("Upload-Offset", offset)
		h.ServeHTTP(w, req)
		require.Equal(t, http.StatusNoContent, w.Code)
	}

	// Each partial PATCH past the threshold may offer the room to the
	// progressive queue. The queue itself deduplicates active work, while a
	// later event can recover from a temporarily full queue.
	patch("0", "0123456789abcdef")
	patch("16", "0123456789abcdef")

	wantPath := filepath.Join(cfg.DataDir, "tus-incoming", uploadID)
	select {
	case got := <-started:
		require.Equal(t, "room1234", got.roomID)
		require.Equal(t, wantPath, got.srcPath)
	case <-time.After(2 * time.Second):
		t.Fatal("onStreamStart not called")
	}
	select {
	case got := <-started:
		require.Equal(t, "room1234", got.roomID)
		require.Equal(t, wantPath, got.srcPath)
	case <-time.After(2 * time.Second):
		t.Fatal("onStreamStart was not offered again")
	}
}

func TestExpiredRoomRemovesTusArtifactsAndCannotResume(t *testing.T) {
	s, cfg := testSetup(t)
	r := &room.Room{ID: "expired1", FileName: "movie.mkv", Status: "uploading",
		ControllerID: "m1", CreatedAt: time.Now(), ExpiresAt: time.Now().Add(time.Second)}
	require.NoError(t, s.Create(context.Background(), r))

	h, err := NewTusHandler(cfg, s, func(string) {}, nil, nil)
	require.NoError(t, err)
	h = http.StripPrefix("/api/upload", h)

	create := httptest.NewRecorder()
	createReq := httptest.NewRequest("POST", "/api/upload/", nil)
	createReq.Header.Set("Tus-Resumable", "1.0.0")
	createReq.Header.Set("Upload-Length", "16")
	createReq.Header.Set("Upload-Metadata", metadataHeader(map[string]string{
		"roomID": "expired1",
	}))
	h.ServeHTTP(create, createReq)
	require.Equal(t, http.StatusCreated, create.Code)

	u, err := url.Parse(create.Header().Get("Location"))
	require.NoError(t, err)
	uploadID := filepath.Base(u.Path)
	require.FileExists(t, filepath.Join(cfg.DataDir, "tus-incoming", uploadID))

	require.Eventually(t, func() bool {
		room.SweepOnce(context.Background(), s, cfg.DataDir)
		_, err := os.Stat(filepath.Join(cfg.DataDir, "tus-incoming", uploadID))
		return os.IsNotExist(err)
	}, 2*time.Second, 10*time.Millisecond)
	require.NoFileExists(t, filepath.Join(cfg.DataDir, "tus-incoming", uploadID+".info"))

	resume := httptest.NewRecorder()
	resumeReq := httptest.NewRequest("PATCH", u.Path, strings.NewReader("fake video bytes"))
	resumeReq.Header.Set("Tus-Resumable", "1.0.0")
	resumeReq.Header.Set("Content-Type", "application/offset+octet-stream")
	resumeReq.Header.Set("Upload-Offset", "0")
	h.ServeHTTP(resume, resumeReq)
	require.Equal(t, http.StatusNotFound, resume.Code)
}

func TestMoveCompletedReportsInfoRemovalFailure(t *testing.T) {
	s, cfg := testSetup(t)
	createRoom(t, s, "room1234", "uploading")

	src := filepath.Join(cfg.DataDir, "tus-incoming", "upload1")
	require.NoError(t, os.MkdirAll(src+".info", 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(src+".info", "child"), []byte("x"), 0o644))
	require.NoError(t, os.WriteFile(src, []byte("fake video bytes"), 0o644))

	err := moveCompleted(cfg, s, "room1234", src)
	require.Error(t, err)
	require.ErrorIs(t, err, syscall.ENOTEMPTY)
}

func TestInvokeCompleteCallbackRecoversPanic(t *testing.T) {
	called := false
	invokeCompleteCallback(func(string) {
		called = true
		panic("boom")
	}, "room1234")
	require.True(t, called)
}

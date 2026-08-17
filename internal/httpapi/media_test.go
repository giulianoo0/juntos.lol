package httpapi

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/room"
)

func TestServeHLSRange(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	addMediaTestRoom(t, store, "r1")
	hlsDir := filepath.Join(cfg.DataDir, "rooms", "r1", "hls")
	require.NoError(t, os.MkdirAll(hlsDir, 0o755))
	require.NoError(t, os.WriteFile(
		filepath.Join(hlsDir, "master.m3u8"),
		[]byte("#EXTM3U\n1234567890"),
		0o644,
	))
	e := gin.New()
	RegisterMediaRoutes(e, cfg, store)
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/media/r1/hls/master.m3u8", nil)
	req.Header.Set("Range", "bytes=0-6")
	e.ServeHTTP(w, req)

	require.Equal(t, http.StatusPartialContent, w.Code)
	require.Equal(t, "#EXTM3U", w.Body.String())
	require.Equal(t, "application/vnd.apple.mpegurl", w.Header().Get("Content-Type"))
	require.Equal(t, "*", w.Header().Get("Access-Control-Allow-Origin"))
}

func TestServeMediaContentTypes(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	addMediaTestRoom(t, store, "r1")
	files := map[string]string{
		"hls/segment.m4s": "video/mp4",
		"subs/sub-0.vtt":  "text/vtt; charset=utf-8",
	}
	for name := range files {
		path := filepath.Join(cfg.DataDir, "rooms", "r1", filepath.FromSlash(name))
		require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
		require.NoError(t, os.WriteFile(path, []byte("data"), 0o644))
	}
	e := gin.New()
	RegisterMediaRoutes(e, cfg, store)

	for name, contentType := range files {
		t.Run(name, func(t *testing.T) {
			w := httptest.NewRecorder()
			e.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/media/r1/"+name, nil))
			require.Equal(t, http.StatusOK, w.Code)
			require.Equal(t, contentType, w.Header().Get("Content-Type"))
		})
	}
}

func TestServeMediaRejectsTraversalAndEscapingSymlink(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	addMediaTestRoom(t, store, "r1")
	hlsDir := filepath.Join(cfg.DataDir, "rooms", "r1", "hls")
	require.NoError(t, os.MkdirAll(hlsDir, 0o755))
	outside := filepath.Join(cfg.DataDir, "secret.m3u8")
	require.NoError(t, os.WriteFile(outside, []byte("secret"), 0o644))
	require.NoError(t, os.Symlink(outside, filepath.Join(hlsDir, "escape.m3u8")))
	e := gin.New()
	RegisterMediaRoutes(e, cfg, store)

	for _, path := range []string{
		"/media/r1/hls/..%2f..%2fsecret.m3u8",
		"/media/r1/hls/escape.m3u8",
	} {
		w := httptest.NewRecorder()
		e.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		require.Contains(t, []int{http.StatusBadRequest, http.StatusNotFound}, w.Code)
		require.NotContains(t, w.Body.String(), "secret")
	}
}

func TestServeMediaRequiresLiveRoom(t *testing.T) {
	cfg := testCfg(t)
	e := gin.New()
	RegisterMediaRoutes(e, cfg, newTestStore(t))
	w := httptest.NewRecorder()
	e.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/media/missing/hls/master.m3u8", nil))
	require.Equal(t, http.StatusNotFound, w.Code)
}

func addMediaTestRoom(t *testing.T, store *room.Store, id string) {
	t.Helper()
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: id, FileName: "movie.mkv", Status: "ready", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
}

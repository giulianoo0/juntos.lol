package httpapi

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
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
	require.Equal(t, "no-store", w.Header().Get("Cache-Control"))
	require.Equal(t, "*", w.Header().Get("Access-Control-Allow-Origin"))
}

func TestServeNormalizesGrowingEventPlaylist(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	addMediaTestRoom(t, store, "r1")
	hlsDir := filepath.Join(cfg.DataDir, "rooms", "r1", "hls")
	require.NoError(t, os.MkdirAll(hlsDir, 0o755))
	require.NoError(t, os.WriteFile(
		filepath.Join(hlsDir, "preview_stream_0.m3u8"),
		[]byte("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:2.005333,\nsegment.m4s\n"),
		0o644,
	))
	e := gin.New()
	RegisterMediaRoutes(e, cfg, store)
	w := httptest.NewRecorder()
	e.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/media/r1/hls/preview_stream_0.m3u8", nil))

	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Body.String(), "#EXT-X-TARGETDURATION:3\n")
	require.Contains(t, w.Body.String(), "#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n")
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

func TestServeMediaRejectsSymlinkedMediaDirectory(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	addMediaTestRoom(t, store, "r1")
	roomDir := filepath.Join(cfg.DataDir, "rooms", "r1")
	require.NoError(t, os.MkdirAll(roomDir, 0o755))
	outside := filepath.Join(cfg.DataDir, "outside")
	require.NoError(t, os.MkdirAll(outside, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(outside, "master.m3u8"), []byte("secret"), 0o644))
	require.NoError(t, os.Symlink(outside, filepath.Join(roomDir, "hls")))
	e := gin.New()
	RegisterMediaRoutes(e, cfg, store)

	w := httptest.NewRecorder()
	e.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/media/r1/hls/master.m3u8", nil))
	require.Equal(t, http.StatusNotFound, w.Code)
	require.NotContains(t, w.Body.String(), "secret")
}

func TestServeMediaRequiresLiveRoom(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "expired", Status: "ready", CreatedAt: now.Add(-2 * time.Hour), ExpiresAt: now.Add(-time.Minute),
	}))
	e := gin.New()
	RegisterMediaRoutes(e, cfg, store)

	for _, roomID := range []string{"missing", "expired"} {
		t.Run(roomID, func(t *testing.T) {
			w := httptest.NewRecorder()
			e.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/media/"+roomID+"/hls/master.m3u8", nil))
			require.Equal(t, http.StatusNotFound, w.Code)
		})
	}
}

func TestServeMediaReportsStoreFailure(t *testing.T) {
	cfg := testCfg(t)
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	store := room.NewStore(rdb, time.Hour)
	require.NoError(t, rdb.Close())
	e := gin.New()
	RegisterMediaRoutes(e, cfg, store)

	w := httptest.NewRecorder()
	e.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/media/r1/hls/master.m3u8", nil))
	require.Equal(t, http.StatusInternalServerError, w.Code)
}

func addMediaTestRoom(t *testing.T, store *room.Store, id string) {
	t.Helper()
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: id, FileName: "movie.mkv", Status: "ready", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
}

func TestMediaCacheControlLetsTheEdgeKeepSegments(t *testing.T) {
	// Segment names carry a sequence number and a re-encode writes new ones,
	// so an edge holding them forever can never serve a stale one — and every
	// viewer it serves is one this machine's 650 Mbps does not have to.
	for _, name := range []string{"stream_1_000.m4s", "init_1.mp4", "preview_stream_1_000000.m4s"} {
		require.Equal(t, "public, max-age=31536000, immutable",
			mediaCacheControl(filepath.Ext(name)), name)
	}
}

func TestMediaCacheControlNeverHoldsAPlaylist(t *testing.T) {
	// An event playlist grows with every segment the progressive remux
	// publishes; a cached one strands the viewer at whatever length it had.
	require.Equal(t, "no-store", mediaCacheControl(".m3u8"))
	require.Equal(t, "no-store", mediaCacheControl(".M3U8"))
}

func TestMediaCacheControlKeepsSubtitlesBriefly(t *testing.T) {
	// Subtitles are republished with more cues as a download proceeds, but
	// their URLs carry a version, so a changed track is a changed URL.
	require.Equal(t, "public, max-age=3600", mediaCacheControl(".vtt"))
}

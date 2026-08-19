package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/room"
)

const testPlaylist = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nstream_0.m3u8\n"

func mediaEngine(store *room.Store) *gin.Engine {
	e := gin.New()
	RegisterMediaRoutes(e, store)
	return e
}

func TestServePlaylistReturnsWhatWasPublished(t *testing.T) {
	store := newTestStore(t)
	addMediaTestRoom(t, store, "r1")
	require.NoError(t, store.SetPlaylists(t.Context(), "r1", map[string]string{"master.m3u8": testPlaylist}))

	w := httptest.NewRecorder()
	mediaEngine(store).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/media/r1/hls/master.m3u8", nil))

	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, testPlaylist, w.Body.String())
	require.Equal(t, "application/vnd.apple.mpegurl", w.Header().Get("Content-Type"))
	require.Equal(t, "*", w.Header().Get("Access-Control-Allow-Origin"))
}

func TestServePlaylistIsNeverCached(t *testing.T) {
	// An event playlist grows with every segment the preview publishes, and a
	// cached one strands a viewer at whatever length it had.
	store := newTestStore(t)
	addMediaTestRoom(t, store, "r1")
	require.NoError(t, store.SetPlaylists(t.Context(), "r1", map[string]string{"master.m3u8": testPlaylist}))

	w := httptest.NewRecorder()
	mediaEngine(store).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/media/r1/hls/master.m3u8", nil))

	require.Equal(t, "no-store", w.Header().Get("Cache-Control"))
}

func TestServePlaylistRefusesAnythingButAPlaylist(t *testing.T) {
	// Segments are delivered by the bucket. Serving them here too would put
	// this machine's bandwidth back in the path it was taken out of.
	store := newTestStore(t)
	addMediaTestRoom(t, store, "r1")
	engine := mediaEngine(store)

	for _, path := range []string{
		"/media/r1/hls/stream_0_000.m4s",
		"/media/r1/hls/init_0.mp4",
		"/media/r1/hls/../../etc/passwd",
		"/media/r1/hls/nested/master.m3u8",
		"/media/r1/hls/",
	} {
		w := httptest.NewRecorder()
		engine.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		require.Equal(t, http.StatusNotFound, w.Code, path)
	}
}

func TestServePlaylistRequiresAPublishedName(t *testing.T) {
	store := newTestStore(t)
	addMediaTestRoom(t, store, "r1")

	w := httptest.NewRecorder()
	mediaEngine(store).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/media/r1/hls/absent.m3u8", nil))

	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestServePlaylistRequiresLiveRoom(t *testing.T) {
	// The bucket serves segments to anyone holding the URL, so this request is
	// where an expired room stops being watchable: a viewer cannot start
	// playback without first being handed a playlist.
	store := newTestStore(t)
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "gone", Status: "ready", CreatedAt: now.Add(-2 * time.Hour), ExpiresAt: now.Add(-time.Minute),
	}))
	require.NoError(t, store.SetPlaylists(t.Context(), "gone", map[string]string{"master.m3u8": testPlaylist}))

	w := httptest.NewRecorder()
	mediaEngine(store).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/media/gone/hls/master.m3u8", nil))

	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestServePlaylistRejectsAnUnknownRoom(t *testing.T) {
	w := httptest.NewRecorder()
	mediaEngine(newTestStore(t)).ServeHTTP(w,
		httptest.NewRequest(http.MethodGet, "/media/nope/hls/master.m3u8", nil))

	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestServePlaylistReportsStoreFailure(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	store := room.NewStore(rdb, time.Hour)
	require.NoError(t, rdb.Close())

	w := httptest.NewRecorder()
	mediaEngine(store).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/media/r1/hls/master.m3u8", nil))

	require.Equal(t, http.StatusInternalServerError, w.Code)
}

func addMediaTestRoom(t *testing.T, store *room.Store, id string) {
	t.Helper()
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: id, FileName: "movie.mkv", Status: "ready", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
}

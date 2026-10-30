package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/worker"
)

func TestTorrentRoutesWithoutService(t *testing.T) {
	r := gin.New()
	RegisterTorrentRoutes(r.Group("/api"), config.Config{}, TorrentAccess{})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/torrents/capacity", nil))
	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Body.String(), `"disabled"`)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/torrents", strings.NewReader(`{}`)))
	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestTorrentRoutesWithoutWorkers(t *testing.T) {
	mr, rdb := newRedis(t)
	_ = mr
	signer, err := worker.LoadOrCreateSigner("")
	require.NoError(t, err)
	registry := worker.NewRegistry(rdb, worker.NewMemoryEnrollments())
	service := &worker.Service{Registry: registry, Hub: worker.NewHub(registry, signer, "secret"), Signer: signer, Blocklist: &worker.Blocklist{}}
	r := gin.New()
	RegisterTorrentRoutes(r.Group("/api"), config.Config{}, TorrentAccess{
		Sessions: NewSessions(rdb, 1e9, 0, false),
		Quota:    NewQuota(rdb, 5, 2, 0),
		Service:  service,
	})

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/torrents/capacity", nil))
	require.Contains(t, w.Body.String(), `"no_workers"`)

	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/torrents", strings.NewReader(`{"infoHash":"nope"}`)))
	require.Equal(t, http.StatusBadRequest, w.Code)

	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/torrents", strings.NewReader(`{"infoHash":"`+strings.Repeat("a", 40)+`"}`)))
	require.Equal(t, http.StatusServiceUnavailable, w.Code)
	require.Contains(t, w.Body.String(), "no_workers")
	require.NotEmpty(t, w.Result().Cookies(), "the session was minted on first sight")

	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/torrents/j_missing", nil))
	require.Equal(t, http.StatusNotFound, w.Code)
}

// The edge lets uploads through by the gigabyte; a JSON ask is never more
// than a few kilobytes, so one that is gets refused before it is read.
func TestTorrentAndYoutubeRefuseAnOversizedBody(t *testing.T) {
	_, rdb := newRedis(t)
	signer, err := worker.LoadOrCreateSigner("")
	require.NoError(t, err)
	registry := worker.NewRegistry(rdb, worker.NewMemoryEnrollments())
	service := &worker.Service{Registry: registry, Hub: worker.NewHub(registry, signer, "secret"), Signer: signer, Blocklist: &worker.Blocklist{}}
	access := TorrentAccess{Sessions: NewSessions(rdb, 1e9, 0, false), Service: service}
	r := gin.New()
	cfg := config.Config{YoutubeFleetEnabled: true}
	RegisterTorrentRoutes(r.Group("/api"), cfg, access)
	RegisterYoutubeRoutes(r.Group("/api"), cfg, access)
	padding := strings.Repeat("a", 2<<20)
	tests := []struct {
		name string
		path string
		body string
	}{
		{"torrent", "/api/torrents", `{"infoHash":"` + strings.Repeat("a", 40) + `","trackers":["` + padding + `"]}`},
		{"youtube", "/api/youtube", `{"url":"https://youtu.be/dQw4w9WgXcQ","pad":"` + padding + `"}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, tt.path, strings.NewReader(tt.body)))
			require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
		})
	}
}

func TestCleanTrackers(t *testing.T) {
	kept, err := cleanTrackers([]string{
		"udp://tracker.opentrackr.org:1337/announce",
		"https://tracker.example/announce",
		"wss://tracker.example/ws",
		"not a url",
		"udp://",
		"http://1.2.3.4:6969/announce",
	})
	require.NoError(t, err)
	require.Equal(t, []string{
		"udp://tracker.opentrackr.org:1337/announce",
		"https://tracker.example/announce",
		"http://1.2.3.4:6969/announce",
	}, kept)

	for _, bad := range []string{
		"http://169.254.169.254/latest/meta-data",
		"http://10.0.0.5:8080/admin",
		"udp://127.0.0.1:53/announce",
		"http://[::1]:9999/",
		"http://[::ffff:10.1.2.3]:80/",
		"udp://239.1.1.1:9999/announce",
	} {
		_, err := cleanTrackers([]string{bad})
		require.Error(t, err, bad)
	}
}

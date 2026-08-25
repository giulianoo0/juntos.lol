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
	registry := worker.NewRegistry(rdb)
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

package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/room"
	"github.com/giulianoo0/ss/internal/usage"
)

func TestUsageReachesData(t *testing.T) {
	_, rdb := newRedis(t)
	server := NewServer(testCfg(t), room.NewStore(rdb, 5*time.Hour), nil, WithUsage(usage.New(rdb, nil)))
	visit := func(ua string) {
		request := httptest.NewRequest(http.MethodPost, "/api/visit", nil)
		request.Header.Set("User-Agent", ua)
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		require.Equal(t, http.StatusNoContent, response.Code)
	}
	visit("Mozilla/5.0 (Macintosh) Firefox/140.0")
	visit("Mozilla/5.0 (Macintosh) Firefox/140.0")
	visit("Mozilla/5.0 (compatible; Googlebot/2.1)")
	visit("Mozilla/5.0 HeadlessChrome/140.0")

	create := httptest.NewRequest(http.MethodPost, "/api/rooms", strings.NewReader(`{"nickname":"Ana"}`))
	create.Header.Set("Content-Type", "application/json")
	created := httptest.NewRecorder()
	server.ServeHTTP(created, create)
	require.Equal(t, http.StatusCreated, created.Code)

	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/data", nil))
	require.Equal(t, http.StatusOK, response.Code)
	var report dataReport
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &report))
	require.Len(t, report.Days, dataDays)
	today := report.Days[len(report.Days)-1].Metrics
	require.Equal(t, int64(1), today["visitors"], "robôs não contam e a mesma pessoa conta uma vez")
	require.Equal(t, int64(2), today["visits"])
	require.Equal(t, int64(1), today["rooms_created"])
	require.Equal(t, 1, report.Now.RoomsByState[room.StatusEmpty])
}

package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/livekit/protocol/auth"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
)

func TestScreenshareToken(t *testing.T) {
	store := newTestStore(t)
	now := time.Now()
	require.NoError(t, store.CreateWithMember(t.Context(), &room.Room{
		ID: "r1", Status: "ready", ControllerID: "m1", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}, room.Member{ID: "m1", Nickname: "giuli", JoinedAt: now}))
	cfg := config.Config{
		LivekitURL: "wss://livekit.example.test", LivekitAPIKey: "api-key", LivekitAPISecret: "api-secret",
	}
	router := gin.New()
	RegisterScreenshareRoute(router.Group("/api"), store, cfg)

	w := doScreenshareJSON(router, "/api/rooms/r1/screenshare/token", `{"nickname":"giuli"}`)
	require.Equal(t, http.StatusOK, w.Code)
	var response struct {
		Token string `json:"token"`
		URL   string `json:"url"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &response))
	require.NotEmpty(t, response.Token)
	require.Equal(t, cfg.LivekitURL, response.URL)

	verifier, err := auth.ParseAPIToken(response.Token)
	require.NoError(t, err)
	claims, grants, err := verifier.Verify(cfg.LivekitAPISecret)
	require.NoError(t, err)
	require.Equal(t, cfg.LivekitAPIKey, verifier.APIKey())
	require.Equal(t, "m1", verifier.Identity())
	require.True(t, grants.Video.RoomJoin)
	require.Equal(t, "r1", grants.Video.Room)
	require.True(t, grants.Video.GetCanPublish())
	require.True(t, grants.Video.GetCanSubscribe())
	require.WithinDuration(t, time.Now().Add(2*time.Hour), claims.ExpiresAt.Time, 5*time.Second)
}

func TestScreenshareTokenDisabled(t *testing.T) {
	router := gin.New()
	RegisterScreenshareRoute(router.Group("/api"), newTestStore(t), config.Config{})
	w := doScreenshareJSON(router, "/api/rooms/r1/screenshare/token", `{"nickname":"giuli"}`)
	require.Equal(t, http.StatusServiceUnavailable, w.Code)
	require.JSONEq(t, `{"error":"screenshare_disabled"}`, w.Body.String())
}

func TestScreenshareTokenRequiresRoomMember(t *testing.T) {
	store := newTestStore(t)
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "r1", Status: "ready", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
	cfg := config.Config{
		LivekitURL: "wss://livekit.example.test", LivekitAPIKey: "api-key", LivekitAPISecret: "api-secret",
	}
	router := gin.New()
	RegisterScreenshareRoute(router.Group("/api"), store, cfg)

	w := doScreenshareJSON(router, "/api/rooms/r1/screenshare/token", `{"nickname":"missing"}`)
	require.Equal(t, http.StatusForbidden, w.Code)
	w = doScreenshareJSON(router, "/api/rooms/missing/screenshare/token", `{"nickname":"missing"}`)
	require.Equal(t, http.StatusNotFound, w.Code)
}

func doScreenshareJSON(router http.Handler, path, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)
	return w
}

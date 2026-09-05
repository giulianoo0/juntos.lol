package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
)

type testMemberAuthorizer struct{ allowed bool }

func (a testMemberAuthorizer) AuthorizeMember(roomID, memberID, capability string) bool {
	return a.allowed && roomID == "r1" && (memberID == "m1" || memberID == "m2") && capability == "secret-capability"
}

var screenshareCfg = config.Config{
	MoqRelayURL: "https://relay.example.test", MoqPublishToken: "pub-token", MoqSubscribeToken: "sub-token",
}

type relayResponse struct {
	URL     string `json:"url"`
	Path    string `json:"path"`
	Publish bool   `json:"publish"`
}

func newScreenshareRouter(t *testing.T, notify func(string)) (*gin.Engine, *room.Store) {
	t.Helper()
	store := newTestStore(t)
	now := time.Now()
	require.NoError(t, store.CreateWithMember(t.Context(), &room.Room{
		ID: "r1", Status: "ready", SourceKind: room.SourceScreen, ControllerID: "m1", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}, room.Member{ID: "m1", Nickname: "giuli", JoinedAt: now}))
	router := gin.New()
	RegisterScreenshareRoutes(router.Group("/api"), store, screenshareCfg, testMemberAuthorizer{allowed: true}, notify)
	return router, store
}

func TestScreenshareRelayByRole(t *testing.T) {
	router, _ := newScreenshareRouter(t, nil)

	w := doScreenshareJSON(router, "/api/rooms/r1/screenshare/token", `{"memberId":"m1","capability":"secret-capability"}`)
	require.Equal(t, http.StatusOK, w.Code)
	var host relayResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &host))
	require.Equal(t, "https://relay.example.test/pub-token", host.URL)
	require.True(t, host.Publish)
	require.Regexp(t, `^juntos/r1/[0-9a-f]{32}\.hang$`, host.Path)

	w = doScreenshareJSON(router, "/api/rooms/r1/screenshare/token", `{"memberId":"m2","capability":"secret-capability"}`)
	require.Equal(t, http.StatusOK, w.Code)
	var viewer relayResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &viewer))
	require.Equal(t, "https://relay.example.test/sub-token", viewer.URL)
	require.False(t, viewer.Publish)
	require.Equal(t, host.Path, viewer.Path, "every member of the room shares one broadcast path")
}

func TestScreenshareRelayDisabled(t *testing.T) {
	router := gin.New()
	RegisterScreenshareRoutes(router.Group("/api"), newTestStore(t), config.Config{}, nil, nil)
	w := doScreenshareJSON(router, "/api/rooms/r1/screenshare/token", `{"memberId":"m1","capability":"secret-capability"}`)
	require.Equal(t, http.StatusServiceUnavailable, w.Code)
	require.JSONEq(t, `{"error":"screenshare_disabled"}`, w.Body.String())
}

func TestScreenshareRelayRequiresRoomMember(t *testing.T) {
	store := newTestStore(t)
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "r1", Status: "ready", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
	router := gin.New()
	RegisterScreenshareRoutes(router.Group("/api"), store, screenshareCfg, testMemberAuthorizer{}, nil)

	w := doScreenshareJSON(router, "/api/rooms/r1/screenshare/token", `{"memberId":"m1","capability":"wrong"}`)
	require.Equal(t, http.StatusForbidden, w.Code)
	w = doScreenshareJSON(router, "/api/rooms/missing/screenshare/token", `{"memberId":"m1","capability":"wrong"}`)
	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestScreenshareLiveFlag(t *testing.T) {
	var notified []string
	router, store := newScreenshareRouter(t, func(id string) { notified = append(notified, id) })

	w := doScreenshareJSON(router, "/api/rooms/r1/screenshare/live", `{"memberId":"m1","capability":"secret-capability","live":true}`)
	require.Equal(t, http.StatusOK, w.Code)
	r, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.True(t, r.ScreenLive)
	require.Equal(t, []string{"r1"}, notified)

	w = doScreenshareJSON(router, "/api/rooms/r1/screenshare/live", `{"memberId":"m1","capability":"secret-capability","live":false}`)
	require.Equal(t, http.StatusOK, w.Code)
	r, err = store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.False(t, r.ScreenLive)

	w = doScreenshareJSON(router, "/api/rooms/r1/screenshare/live", `{"memberId":"m2","capability":"secret-capability","live":true}`)
	require.Equal(t, http.StatusForbidden, w.Code)
	w = doScreenshareJSON(router, "/api/rooms/r1/screenshare/live", `{"memberId":"m1","capability":"secret-capability"}`)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestSwapSourceClearsScreenLive(t *testing.T) {
	_, store := newScreenshareRouter(t, nil)
	require.NoError(t, store.SetScreenLive(t.Context(), "r1", true))
	_, _, err := store.SwapSource(t.Context(), "r1", room.SourceScreen, "", "ready", time.Now())
	require.NoError(t, err)
	r, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.False(t, r.ScreenLive)
}

func doScreenshareJSON(router http.Handler, path, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)
	return w
}

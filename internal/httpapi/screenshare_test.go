package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
)

type testMemberAuthorizer struct{ allowed bool }

func (a testMemberAuthorizer) AuthorizeMember(roomID, memberID, capability string) bool {
	return a.allowed && roomID == "r1" && strings.HasPrefix(memberID, "m") && capability == "secret-capability"
}

var screenshareCfg = config.Config{
	MoqRelayURL: "https://relay.example.test", MoqPublishToken: "pub-token", MoqSubscribeToken: "sub-token",
}

type relayResponse struct {
	URL     string `json:"url"`
	Base    string `json:"base"`
	Path    string `json:"path"`
	Publish bool   `json:"publish"`
	Open    bool   `json:"open"`
}

func newScreenshareRouter(t *testing.T, notify func(string)) (*gin.Engine, *room.Store) {
	t.Helper()
	store := newTestStore(t)
	now := time.Now()
	require.NoError(t, store.CreateWithMember(t.Context(), &room.Room{
		ID: "r1", Status: "ready", SourceKind: room.SourceScreen, ControllerID: "m1", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}, room.Member{ID: "m1", Nickname: "giuli", JoinedAt: now}))
	require.NoError(t, store.AddMember(t.Context(), "r1", room.Member{ID: "m2", Nickname: "enzoka", JoinedAt: now}))
	router := gin.New()
	RegisterScreenshareRoutes(router.Group("/api"), store, screenshareCfg, testMemberAuthorizer{allowed: true}, notify)
	return router, store
}

func TestScreenshareRelayByRole(t *testing.T) {
	router, store := newScreenshareRouter(t, nil)

	// Without asking to publish, even the host only gets the subscribe token.
	w := doScreenshareJSON(router, "/api/rooms/r1/screenshare/token", `{"memberId":"m1","capability":"secret-capability"}`)
	require.Equal(t, http.StatusOK, w.Code)
	var host relayResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &host))
	require.Equal(t, "https://relay.example.test/sub-token", host.URL)
	require.True(t, host.Publish)

	w = doScreenshareJSON(router, "/api/rooms/r1/screenshare/token", `{"memberId":"m1","capability":"secret-capability","publish":true}`)
	require.Equal(t, http.StatusOK, w.Code)
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &host))
	require.Equal(t, "https://relay.example.test/pub-token", host.URL)
	require.True(t, host.Publish)
	require.True(t, host.Open)
	require.Regexp(t, `^juntos/r1/[0-9a-f]{32}$`, host.Base)
	require.Equal(t, host.Base+"/m1.hang", host.Path)

	// Sharing is open by default, so a guest gets a publish token of their own
	// on a path of their own.
	w = doScreenshareJSON(router, "/api/rooms/r1/screenshare/token", `{"memberId":"m2","capability":"secret-capability","publish":true}`)
	require.Equal(t, http.StatusOK, w.Code)
	var guest relayResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &guest))
	require.Equal(t, "https://relay.example.test/pub-token", guest.URL)
	require.True(t, guest.Publish)
	require.Equal(t, host.Base, guest.Base, "every screen of a room hangs off one base")
	require.Equal(t, host.Base+"/m2.hang", guest.Path)

	require.NoError(t, store.SetScreenShareOpen(t.Context(), "r1", false))
	w = doScreenshareJSON(router, "/api/rooms/r1/screenshare/token", `{"memberId":"m2","capability":"secret-capability","publish":true}`)
	require.Equal(t, http.StatusOK, w.Code)
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &guest))
	require.Equal(t, "https://relay.example.test/sub-token", guest.URL)
	require.False(t, guest.Publish)
	require.False(t, guest.Open)
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

func TestScreenshareLiveListsEveryPublisher(t *testing.T) {
	var notified []string
	router, store := newScreenshareRouter(t, func(id string) { notified = append(notified, id) })

	for _, member := range []string{"m1", "m2"} {
		w := doScreenshareJSON(router, "/api/rooms/r1/screenshare/live", `{"memberId":"`+member+`","capability":"secret-capability","live":true}`)
		require.Equal(t, http.StatusOK, w.Code)
	}
	r, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Len(t, r.Screens, 2)
	require.Equal(t, "m1", r.Screens[0].MemberID)
	require.Equal(t, "giuli", r.Screens[0].Nickname)
	require.Equal(t, "m2", r.Screens[1].MemberID)
	require.Equal(t, "enzoka", r.Screens[1].Nickname)
	require.False(t, r.Screens[1].Since.IsZero())
	require.Equal(t, []string{"r1", "r1"}, notified)

	w := doScreenshareJSON(router, "/api/rooms/r1/screenshare/live", `{"memberId":"m2","capability":"secret-capability","live":false}`)
	require.Equal(t, http.StatusOK, w.Code)
	r, err = store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Len(t, r.Screens, 1)
	require.Equal(t, "m1", r.Screens[0].MemberID)

	w = doScreenshareJSON(router, "/api/rooms/r1/screenshare/live", `{"memberId":"m1","capability":"secret-capability"}`)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestScreenshareClosedRefusesGuestPublish(t *testing.T) {
	router, store := newScreenshareRouter(t, nil)
	require.NoError(t, store.SetScreenShareOpen(t.Context(), "r1", false))

	w := doScreenshareJSON(router, "/api/rooms/r1/screenshare/live", `{"memberId":"m2","capability":"secret-capability","live":true}`)
	require.Equal(t, http.StatusForbidden, w.Code)
	require.JSONEq(t, `{"error":"sharing_closed"}`, w.Body.String())

	// The host is never blocked by their own switch.
	w = doScreenshareJSON(router, "/api/rooms/r1/screenshare/live", `{"memberId":"m1","capability":"secret-capability","live":true}`)
	require.Equal(t, http.StatusOK, w.Code)
}

func TestScreenshareOpenSwitch(t *testing.T) {
	var notified []string
	router, store := newScreenshareRouter(t, func(id string) { notified = append(notified, id) })
	for _, member := range []string{"m1", "m2"} {
		doScreenshareJSON(router, "/api/rooms/r1/screenshare/live", `{"memberId":"`+member+`","capability":"secret-capability","live":true}`)
	}
	notified = nil

	w := doScreenshareJSON(router, "/api/rooms/r1/screenshare/open", `{"memberId":"m2","capability":"secret-capability","open":false}`)
	require.Equal(t, http.StatusForbidden, w.Code)

	w = doScreenshareJSON(router, "/api/rooms/r1/screenshare/open", `{"memberId":"m1","capability":"secret-capability","open":false}`)
	require.Equal(t, http.StatusOK, w.Code)
	r, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.False(t, r.ScreenShareOpen)
	require.Len(t, r.Screens, 1, "closing the room keeps the host's own screen")
	require.Equal(t, "m1", r.Screens[0].MemberID)
	require.Equal(t, []string{"r1"}, notified)

	w = doScreenshareJSON(router, "/api/rooms/r1/screenshare/open", `{"memberId":"m1","capability":"secret-capability","open":true}`)
	require.Equal(t, http.StatusOK, w.Code)
	r, err = store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.True(t, r.ScreenShareOpen)

	w = doScreenshareJSON(router, "/api/rooms/r1/screenshare/open", `{"memberId":"m1","capability":"secret-capability"}`)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestSwapSourceClearsScreens(t *testing.T) {
	_, store := newScreenshareRouter(t, nil)
	require.NoError(t, store.StartScreenShare(t.Context(), "r1", room.ScreenShare{MemberID: "m1", Nickname: "giuli", Since: time.Now()}, true))
	_, _, err := store.SwapSource(t.Context(), "r1", room.SourceScreen, "", "ready", time.Now())
	require.NoError(t, err)
	r, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Empty(t, r.Screens)
}

func doScreenshareJSON(router http.Handler, path, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)
	return w
}

func TestScreenshareCapsSimultaneousScreens(t *testing.T) {
	router, store := newScreenshareRouter(t, nil)
	for i := 3; i <= room.MaxScreenShares+5; i++ {
		require.NoError(t, store.AddMember(t.Context(), "r1", room.Member{ID: fmt.Sprintf("m%d", i), Nickname: "x", JoinedAt: time.Now()}))
	}
	for i := 1; i <= room.MaxScreenShares; i++ {
		w := doScreenshareJSON(router, "/api/rooms/r1/screenshare/live", fmt.Sprintf(`{"memberId":"m%d","capability":"secret-capability","live":true}`, i))
		require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	}
	w := doScreenshareJSON(router, "/api/rooms/r1/screenshare/live", `{"memberId":"m9","capability":"secret-capability","live":true}`)
	require.Equal(t, http.StatusConflict, w.Code)
	require.JSONEq(t, `{"error":"too_many_screens"}`, w.Body.String())

	// A member already listed may re-announce without counting twice.
	w = doScreenshareJSON(router, "/api/rooms/r1/screenshare/live", `{"memberId":"m1","capability":"secret-capability","live":true}`)
	require.Equal(t, http.StatusOK, w.Code)

	stored, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Len(t, stored.Screens, room.MaxScreenShares)
}

func TestScreenshareUnreadableShareIsSkipped(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })
	store := room.NewStore(rdb, 5*time.Hour)
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "r1", Status: "ready", SourceKind: room.SourceScreen, ControllerID: "m1", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
	require.NoError(t, store.StartScreenShare(t.Context(), "r1", room.ScreenShare{MemberID: "m1", Nickname: "giuli", Since: now}, true))
	mr.HSet("room:r1", "screen_share:m2", "{not json")
	stored, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Len(t, stored.Screens, 1)
	require.Equal(t, "m1", stored.Screens[0].MemberID)
}

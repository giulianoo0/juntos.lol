package httpapi

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
)

type callRelayResponse struct {
	URL        string `json:"url"`
	PublishURL string `json:"publishUrl"`
	Base       string `json:"base"`
	Path       string `json:"path"`
	Bridge     string `json:"bridge"`
}

func newCallRouter(t *testing.T, cfg config.Config, authorizer memberAuthorizer) *gin.Engine {
	t.Helper()
	store := newTestStore(t)
	now := time.Now()
	require.NoError(t, store.CreateWithMember(t.Context(), &room.Room{
		ID: "r1", Status: "ready", ControllerID: "m1", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}, room.Member{ID: "m1", Nickname: "giuli", JoinedAt: now}))
	router := gin.New()
	RegisterCallRoutes(router.Group("/api"), store, cfg, authorizer)
	return router
}

func TestCallTokenGivesEveryMemberTheirOwnPath(t *testing.T) {
	router := newCallRouter(t, screenshareCfg, testMemberAuthorizer{allowed: true})

	for _, member := range []string{"m1", "m2"} {
		w := doScreenshareJSON(router, "/api/rooms/r1/call/token", `{"memberId":"`+member+`","capability":"secret-capability"}`)
		require.Equal(t, http.StatusOK, w.Code)
		var relay callRelayResponse
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &relay))
		require.Equal(t, "https://relay.example.test/sub-token", relay.URL)
		require.Equal(t, "https://relay.example.test/pub-token", relay.PublishURL, "a guest publishes their camera without asking anyone")
		require.Regexp(t, `^juntos/r1/[0-9a-f]{32}$`, relay.Base)
		require.Equal(t, relay.Base+"/av/"+member+".hang", relay.Path)
		require.Equal(t, "/moq-bridge", relay.Bridge)
	}
}

func TestCallTokenRefusesStrangers(t *testing.T) {
	router := newCallRouter(t, screenshareCfg, testMemberAuthorizer{})
	w := doScreenshareJSON(router, "/api/rooms/r1/call/token", `{"memberId":"m1","capability":"wrong"}`)
	require.Equal(t, http.StatusForbidden, w.Code)
	w = doScreenshareJSON(router, "/api/rooms/missing/call/token", `{"memberId":"m1","capability":"secret-capability"}`)
	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestCallTokenWithoutRelay(t *testing.T) {
	router := newCallRouter(t, config.Config{}, testMemberAuthorizer{allowed: true})
	w := doScreenshareJSON(router, "/api/rooms/r1/call/token", `{"memberId":"m1","capability":"secret-capability"}`)
	require.Equal(t, http.StatusServiceUnavailable, w.Code)
	require.JSONEq(t, `{"error":"call_disabled"}`, w.Body.String())
}

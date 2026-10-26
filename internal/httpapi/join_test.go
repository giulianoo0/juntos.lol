package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
)

type fakeTickets struct{}

func (fakeTickets) MintTicket(roomID string) string { return "ticket-for-" + roomID }

func newJoinRouter(t *testing.T, mode, password string) (*gin.Engine, *room.Store, *[]string) {
	t.Helper()
	store := newTestStore(t)
	now := time.Now()
	require.NoError(t, store.CreateWithMember(t.Context(), &room.Room{
		ID: "r1", Status: "ready", ControllerID: "m1", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}, room.Member{ID: "m1", Nickname: "giuli", JoinedAt: now}))
	for i, nickname := range []string{"ana", "bia", "caio", "duda", "edu", "fafa"} {
		require.NoError(t, store.AddMember(t.Context(), "r1", room.Member{ID: fmt.Sprintf("m%d", i+2), Nickname: nickname, JoinedAt: now.Add(time.Duration(i+1) * time.Second)}))
	}
	access := room.Access{Mode: mode}
	if password != "" {
		hash, err := room.HashPassword(password)
		require.NoError(t, err)
		access.PasswordHash = hash
	}
	require.NoError(t, store.SetAccess(t.Context(), "r1", access))
	var notified []string
	router := gin.New()
	RegisterJoinRoutes(router.Group("/api"), store, config.Config{}, fakeTickets{}, testMemberAuthorizer{allowed: true}, func(id string) { notified = append(notified, id) })
	return router, store, &notified
}

func doJSON(router http.Handler, method, path, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)
	return w
}

func TestJoinTradesThePasswordForATicket(t *testing.T) {
	router, _, _ := newJoinRouter(t, room.JoinPassword, "pipoca")

	w := doJSON(router, http.MethodPost, "/api/rooms/r1/join", `{"password":"milho"}`)
	require.Equal(t, http.StatusUnauthorized, w.Code)
	require.JSONEq(t, `{"error":"bad_password"}`, w.Body.String())

	w = doJSON(router, http.MethodPost, "/api/rooms/r1/join", `{"password":"pipoca"}`)
	require.Equal(t, http.StatusOK, w.Code)
	require.JSONEq(t, `{"ticket":"ticket-for-r1"}`, w.Body.String())

	w = doJSON(router, http.MethodPost, "/api/rooms/missing/join", `{"password":"pipoca"}`)
	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestJoinLimitsGuessing(t *testing.T) {
	router, _, _ := newJoinRouter(t, room.JoinPassword, "pipoca")
	for range joinAttemptsPerIP {
		require.Equal(t, http.StatusUnauthorized, doJSON(router, http.MethodPost, "/api/rooms/r1/join", `{"password":"milho"}`).Code)
	}
	w := doJSON(router, http.MethodPost, "/api/rooms/r1/join", `{"password":"pipoca"}`)
	require.Equal(t, http.StatusTooManyRequests, w.Code, "even the right password waits once the budget is spent")
}

func TestJoinOpenRoomNeedsNoPassword(t *testing.T) {
	router, _, _ := newJoinRouter(t, room.JoinOpen, "")
	w := doJSON(router, http.MethodPost, "/api/rooms/r1/join", `{}`)
	require.Equal(t, http.StatusOK, w.Code)
	require.JSONEq(t, `{"ticket":"ticket-for-r1"}`, w.Body.String())
}

func TestPreviewShowsTheDoorNotTheRoom(t *testing.T) {
	router, _, _ := newJoinRouter(t, room.JoinPassword, "pipoca")
	w := doJSON(router, http.MethodGet, "/api/rooms/r1/preview", "")
	require.Equal(t, http.StatusOK, w.Code)
	var preview struct {
		JoinMode    string   `json:"joinMode"`
		MemberCount int      `json:"memberCount"`
		Nicknames   []string `json:"nicknames"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &preview))
	require.Equal(t, room.JoinPassword, preview.JoinMode)
	require.Equal(t, 7, preview.MemberCount)
	require.Equal(t, []string{"giuli", "ana", "bia", "caio", "duda"}, preview.Nicknames)
	require.NotContains(t, w.Body.String(), "argon2")

	require.Equal(t, http.StatusNotFound, doJSON(router, http.MethodGet, "/api/rooms/missing/preview", "").Code)
}

func TestAccessIsTheHostsSwitch(t *testing.T) {
	router, store, notified := newJoinRouter(t, room.JoinOpen, "")

	w := doJSON(router, http.MethodPatch, "/api/rooms/r1/access", `{"memberId":"m2","capability":"secret-capability","joinMode":"approval"}`)
	require.Equal(t, http.StatusForbidden, w.Code)

	w = doJSON(router, http.MethodPatch, "/api/rooms/r1/access", `{"memberId":"m1","capability":"secret-capability","joinMode":"password"}`)
	require.Equal(t, http.StatusBadRequest, w.Code, "a password room needs a password")

	w = doJSON(router, http.MethodPatch, "/api/rooms/r1/access", `{"memberId":"m1","capability":"secret-capability","joinMode":"password","password":"pipoca"}`)
	require.Equal(t, http.StatusOK, w.Code)
	access, err := store.Access(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, room.JoinPassword, access.Mode)
	require.True(t, room.VerifyPassword("pipoca", access.PasswordHash))
	require.Equal(t, []string{"r1"}, *notified)

	// Asking for password mode again without one keeps the password already set.
	w = doJSON(router, http.MethodPatch, "/api/rooms/r1/access", `{"memberId":"m1","capability":"secret-capability","joinMode":"password"}`)
	require.Equal(t, http.StatusOK, w.Code)
	access, err = store.Access(t.Context(), "r1")
	require.NoError(t, err)
	require.True(t, room.VerifyPassword("pipoca", access.PasswordHash))

	w = doJSON(router, http.MethodPatch, "/api/rooms/r1/access", `{"memberId":"m1","capability":"secret-capability","joinMode":"approval"}`)
	require.Equal(t, http.StatusOK, w.Code)
	w = doJSON(router, http.MethodPatch, "/api/rooms/r1/access", `{"memberId":"m1","capability":"secret-capability","joinMode":"bogus"}`)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestCreateRoomWithAPassword(t *testing.T) {
	store := newTestStore(t)
	router := gin.New()
	RegisterRoomRoutes(router.Group("/api"), store, testCfg(t))

	w := doJSON(router, http.MethodPost, "/api/rooms", `{"nickname":"giuli","kind":"screen","joinMode":"password"}`)
	require.Equal(t, http.StatusBadRequest, w.Code)

	w = doJSON(router, http.MethodPost, "/api/rooms", `{"nickname":"giuli","kind":"screen","joinMode":"password","password":"pipoca"}`)
	require.Equal(t, http.StatusCreated, w.Code)
	var created struct {
		ID string `json:"id"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))
	access, err := store.Access(t.Context(), created.ID)
	require.NoError(t, err)
	require.Equal(t, room.JoinPassword, access.Mode)
	require.True(t, room.VerifyPassword("pipoca", access.PasswordHash))

	w = doJSON(router, http.MethodPost, "/api/rooms", `{"nickname":"giuli","kind":"screen","joinMode":"approval"}`)
	require.Equal(t, http.StatusCreated, w.Code)
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))
	access, err = store.Access(t.Context(), created.ID)
	require.NoError(t, err)
	require.Equal(t, room.JoinApproval, access.Mode)
}

func TestCreateRoomIsRateLimitedPerAddress(t *testing.T) {
	store := newTestStore(t)
	router := gin.New()
	cfg := testCfg(t)
	cfg.RoomsPerIPPerHour = 3
	RegisterRoomRoutes(router.Group("/api"), store, cfg)
	for range cfg.RoomsPerIPPerHour {
		require.Equal(t, http.StatusCreated, doJSON(router, http.MethodPost, "/api/rooms", `{"nickname":"giuli","kind":"screen"}`).Code)
	}
	require.Equal(t, http.StatusTooManyRequests, doJSON(router, http.MethodPost, "/api/rooms", `{"nickname":"giuli","kind":"screen"}`).Code)
}

func TestLockedRoomIsReadOnlyByItsMembers(t *testing.T) {
	store := newTestStore(t)
	router := gin.New()
	RegisterRoomRoutes(router.Group("/api"), store, testCfg(t), anyRoomMember{})

	w := doJSON(router, http.MethodPost, "/api/rooms", `{"nickname":"giuli","joinMode":"password","password":"pipoca"}`)
	require.Equal(t, http.StatusCreated, w.Code)
	var created struct {
		ID string `json:"id"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))

	w = doJSON(router, http.MethodGet, "/api/rooms/"+created.ID, "")
	require.Equal(t, http.StatusForbidden, w.Code)
	require.NotContains(t, w.Body.String(), "mediaBaseUrl")

	request := httptest.NewRequest(http.MethodGet, "/api/rooms/"+created.ID, nil)
	request.Header.Set("X-Member-Id", "m1")
	request.Header.Set("X-Capability", "secret-capability")
	w = httptest.NewRecorder()
	router.ServeHTTP(w, request)
	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Body.String(), `"joinMode":"password"`)
}

type anyRoomMember struct{}

func (anyRoomMember) AuthorizeMember(_, memberID, capability string) bool {
	return memberID == "m1" && capability == "secret-capability"
}

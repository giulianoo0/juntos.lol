package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/room"
)

func TestCreateRoomIsBornEmptyWithItsCreatorInControl(t *testing.T) {
	s := newTestStore(t)
	e := gin.New()
	RegisterRoomRoutes(e.Group("/api"), s, testCfg(t))
	w := httptest.NewRecorder()
	body := `{"nickname":"giuli","name":"Sexta do terror"}`
	req := httptest.NewRequest("POST", "/api/rooms", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	e.ServeHTTP(w, req)
	require.Equal(t, 201, w.Code)
	var resp struct {
		ID        string
		ExpiresAt time.Time
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	require.Len(t, resp.ID, 8)
	require.False(t, resp.ExpiresAt.IsZero())

	ctx := context.Background()
	got, err := s.Get(ctx, resp.ID)
	require.NoError(t, err)
	require.Equal(t, room.StatusEmpty, got.Status, "a room is born without media")
	require.Equal(t, "Sexta do terror", got.Name)
	require.Empty(t, got.FileName)
	require.Equal(t, "m1", got.ControllerID)
	members, err := s.Members(ctx, resp.ID)
	require.NoError(t, err)
	require.Len(t, members, 1)
	require.Equal(t, "m1", members[0].ID)
	require.Equal(t, "giuli", members[0].Nickname)
}

func TestCreateRoomGeneratesNicknameWhenOmitted(t *testing.T) {
	s := newTestStore(t)
	e := gin.New()
	RegisterRoomRoutes(e.Group("/api"), s, testCfg(t))
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/rooms", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	e.ServeHTTP(w, req)

	require.Equal(t, http.StatusCreated, w.Code)
	var resp struct {
		ID       string
		Nickname string
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	require.Regexp(t, `^Guest-[A-Za-z0-9_-]{6}$`, resp.Nickname)
	members, err := s.Members(context.Background(), resp.ID)
	require.NoError(t, err)
	require.Len(t, members, 1)
	require.Equal(t, resp.Nickname, members[0].Nickname)
}

func TestCreateRoomRejectsOversizedOrUnsafeFields(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{
			name: "oversized name",
			body: `{"name":"` + strings.Repeat("a", 81) + `","nickname":"giuli"}`,
		},
		{
			name: "control character name",
			body: `{"name":"sex\nta","nickname":"giuli"}`,
		},
		{
			name: "control character nickname",
			body: `{"nickname":"giu\nli"}`,
		},
		{
			name: "oversized body",
			body: `{"nickname":"` + strings.Repeat("a", 4096) + `"}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := newTestStore(t)
			e := gin.New()
			RegisterRoomRoutes(e.Group("/api"), s, testCfg(t))
			w := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/api/rooms", strings.NewReader(tt.body))
			req.Header.Set("Content-Type", "application/json")
			e.ServeHTTP(w, req)
			require.Equal(t, http.StatusBadRequest, w.Code)
		})
	}
}

func TestGetRoom(t *testing.T) {
	s := newTestStore(t)
	e := gin.New()
	RegisterRoomRoutes(e.Group("/api"), s, testCfg(t))

	r := &room.Room{ID: "abc12345", Name: "Sexta", FileName: "movie.mkv", Status: "uploading",
		ControllerID: "m1", CreatedAt: time.Now(), ExpiresAt: time.Now().Add(5 * time.Hour)}
	require.NoError(t, s.Create(context.Background(), r))
	require.NoError(t, s.SetSpotlight(context.Background(), r.ID, &room.Spotlight{Kind: room.StageMedia}))
	require.NoError(t, s.AddMember(context.Background(), r.ID, room.Member{
		ID: "m1", Nickname: "giuli", JoinedAt: time.Now(),
	}))

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/rooms/abc12345", nil)
	e.ServeHTTP(w, req)
	require.Equal(t, 200, w.Code)
	var resp struct {
		ID             string
		Name           string
		Status         string
		Spotlight      *room.Spotlight
		MemberCount    int
		AudioTracks    []room.TrackInfo
		SubtitleTracks []room.TrackInfo
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	require.Equal(t, "abc12345", resp.ID)
	require.Equal(t, "uploading", resp.Status)
	require.Equal(t, 1, resp.MemberCount)
	require.Equal(t, "Sexta", resp.Name)
	require.Equal(t, &room.Spotlight{Kind: room.StageMedia}, resp.Spotlight)
	require.NotContains(t, w.Body.String(), "sourceKind")
	require.NotContains(t, w.Body.String(), "screenShareOpen")
}

func TestGetRoomCarriesTheProducerHeartbeat(t *testing.T) {
	s := newTestStore(t)
	e := gin.New()
	RegisterRoomRoutes(e.Group("/api"), s, testCfg(t))

	r := &room.Room{ID: "abc12345", FileName: "movie.mkv", Status: "ready",
		ControllerID: "m1", CreatedAt: time.Now(), ExpiresAt: time.Now().Add(5 * time.Hour)}
	require.NoError(t, s.Create(context.Background(), r))
	require.NoError(t, s.TouchClientClaim(context.Background(), r.ID))

	w := httptest.NewRecorder()
	e.ServeHTTP(w, httptest.NewRequest("GET", "/api/rooms/abc12345", nil))
	require.Equal(t, 200, w.Code)

	var resp map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	beat, ok := resp["producerHeartbeatMs"].(float64)
	require.True(t, ok, "producerHeartbeatMs missing from the room response: %s", w.Body.String())
	require.Greater(t, beat, float64(0))
}

// A room past its time is as gone as a deleted one, the way the socket and
// the preview already see it, until the sweeper gets to it.
func TestGetRoomNotFound(t *testing.T) {
	tests := []struct {
		name string
		id   string
	}{
		{"room that never existed", "missing1"},
		{"room past its expiry", "expired1"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := newTestStore(t)
			e := gin.New()
			RegisterRoomRoutes(e.Group("/api"), s, testCfg(t))
			require.NoError(t, s.Create(context.Background(), &room.Room{ID: "expired1", Status: "ready",
				CreatedAt: time.Now().Add(-6 * time.Hour), ExpiresAt: time.Now().Add(-time.Minute)}))
			w := httptest.NewRecorder()
			e.ServeHTTP(w, httptest.NewRequest("GET", "/api/rooms/"+tt.id, nil))
			require.Equal(t, 404, w.Code)
			var resp struct{ Error string }
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
			require.Equal(t, "room_not_found", resp.Error)
		})
	}
}

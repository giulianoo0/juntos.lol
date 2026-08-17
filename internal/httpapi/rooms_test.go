package httpapi

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/room"
)

func TestCreateRoom(t *testing.T) {
	s := newTestStore(t) // helper: miniredis + NewStore
	e := gin.New()
	RegisterRoomRoutes(e.Group("/api"), s, testCfg())
	w := httptest.NewRecorder()
	body := `{"fileName":"movie.mkv","nickname":"giuli"}`
	req := httptest.NewRequest("POST", "/api/rooms", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	e.ServeHTTP(w, req)
	require.Equal(t, 201, w.Code)
	var resp struct{ ID, UploadEndpoint string }
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	require.Len(t, resp.ID, 8)
	got, _ := s.Get(context.Background(), resp.ID)
	require.Equal(t, "uploading", got.Status)
}

func TestCreateRoomRegistersController(t *testing.T) {
	s := newTestStore(t)
	e := gin.New()
	RegisterRoomRoutes(e.Group("/api"), s, testCfg())
	w := httptest.NewRecorder()
	body := `{"fileName":"movie.mkv","nickname":"giuli"}`
	req := httptest.NewRequest("POST", "/api/rooms", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	e.ServeHTTP(w, req)
	require.Equal(t, 201, w.Code)
	var resp struct {
		ID        string
		ExpiresAt time.Time
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	require.False(t, resp.ExpiresAt.IsZero())

	ctx := context.Background()
	got, err := s.Get(ctx, resp.ID)
	require.NoError(t, err)
	require.Equal(t, "m1", got.ControllerID)
	require.Equal(t, "movie.mkv", got.FileName)
	members, err := s.Members(ctx, resp.ID)
	require.NoError(t, err)
	require.Len(t, members, 1)
	require.Equal(t, "m1", members[0].ID)
	require.Equal(t, "giuli", members[0].Nickname)
}

func TestGetRoom(t *testing.T) {
	s := newTestStore(t)
	e := gin.New()
	RegisterRoomRoutes(e.Group("/api"), s, testCfg())

	r := &room.Room{ID: "abc12345", FileName: "movie.mkv", Status: "uploading",
		ControllerID: "m1", CreatedAt: time.Now(), ExpiresAt: time.Now().Add(5 * time.Hour)}
	require.NoError(t, s.Create(context.Background(), r))
	require.NoError(t, s.AddMember(context.Background(), r.ID, room.Member{
		ID: "m1", Nickname: "giuli", JoinedAt: time.Now(),
	}))

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/rooms/abc12345", nil)
	e.ServeHTTP(w, req)
	require.Equal(t, 200, w.Code)
	var resp struct {
		ID             string
		Status         string
		MemberCount    int
		AudioTracks    []room.TrackInfo
		SubtitleTracks []room.TrackInfo
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	require.Equal(t, "abc12345", resp.ID)
	require.Equal(t, "uploading", resp.Status)
	require.Equal(t, 1, resp.MemberCount)
}

func TestGetRoomNotFound(t *testing.T) {
	s := newTestStore(t)
	e := gin.New()
	RegisterRoomRoutes(e.Group("/api"), s, testCfg())
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/rooms/missing1", nil)
	e.ServeHTTP(w, req)
	require.Equal(t, 404, w.Code)
	var resp struct{ Error string }
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	require.Equal(t, "room_not_found", resp.Error)
}

package httpapi

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
)

func postSource(t *testing.T, e *gin.Engine, roomID, body string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/rooms/"+roomID+"/source", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	e.ServeHTTP(w, req)
	return w
}

// sourceRoom seeds a ready room that already holds media from a first source.
func sourceRoom(t *testing.T, cfg config.Config, store *room.Store) *gin.Engine {
	t.Helper()
	now := time.Now()
	require.NoError(t, store.CreateWithMember(t.Context(), &room.Room{
		ID: "r1", FileName: "first.mkv", Status: "ready", SourceKind: room.SourceUpload,
		ControllerID: "m1", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
		AudioTracks:    []room.TrackInfo{{Index: 0, Language: "eng", Codec: "aac"}},
		SubtitleTracks: []room.TrackInfo{{Index: 0, Language: "eng", Codec: "webvtt"}},
	}, room.Member{ID: "m1", Nickname: "giuli", JoinedAt: now}))

	hls := filepath.Join(cfg.DataDir, "rooms", "r1", "hls")
	require.NoError(t, os.MkdirAll(hls, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(hls, "master.m3u8"), []byte("#EXTM3U"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(cfg.DataDir, "rooms", "r1", "original.mkv"), []byte("media"), 0o644))
	return gin.New()
}

func TestChangeSourceToScreen(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	e := sourceRoom(t, cfg, store)
	var notified []string
	RegisterSourceRoute(e.Group("/api"), store, cfg, testMemberAuthorizer{allowed: true}, SourceHooks{
		NotifyStatus: func(_, status string) { notified = append(notified, status) },
	})

	w := postSource(t, e, "r1", `{"memberId":"m1","capability":"secret-capability","kind":"screen"}`)
	require.Equal(t, http.StatusOK, w.Code)

	got, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	// A shared screen is live immediately: there is nothing to prepare.
	require.Equal(t, "ready", got.Status)
	require.Equal(t, room.SourceScreen, got.SourceKind)
	require.Equal(t, 1, got.MediaGeneration)
	// Nothing describing the retired media may survive the swap.
	require.Empty(t, got.AudioTracks)
	require.Empty(t, got.SubtitleTracks)
	require.Empty(t, got.FileName)
	require.NoDirExists(t, filepath.Join(cfg.DataDir, "rooms", "r1"))
	require.Equal(t, []string{"ready"}, notified)

	// Members, chat and the controller all stay: nobody changes rooms.
	members, err := store.Members(t.Context(), "r1")
	require.NoError(t, err)
	require.Len(t, members, 1)
	require.Equal(t, "m1", got.ControllerID)
}

func TestChangeSourceToUploadReopensTheUploadWindow(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	e := sourceRoom(t, cfg, store)
	// A first remux still holds its claim when the controller changes their mind.
	require.NoError(t, store.SetStatus(t.Context(), "r1", "uploading"))
	require.NoError(t, store.ReserveUpload(t.Context(), "r1", "claim-one", time.Now()))

	canceled := make([]string, 0, 1)
	RegisterSourceRoute(e.Group("/api"), store, cfg, testMemberAuthorizer{allowed: true}, SourceHooks{
		CancelMedia: func(roomID string) { canceled = append(canceled, roomID) },
	})

	w := postSource(t, e, "r1", `{"memberId":"m1","capability":"secret-capability","kind":"upload","fileName":"second.mkv"}`)
	require.Equal(t, http.StatusOK, w.Code)

	got, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, "uploading", got.Status)
	require.Equal(t, "second.mkv", got.FileName)
	require.Equal(t, room.SourceUpload, got.SourceKind)
	require.Equal(t, []string{"r1"}, canceled)

	// The replacement remux can claim the room, which the previous claim
	// would otherwise have blocked forever.
	require.NoError(t, store.ReserveUpload(t.Context(), "r1", "claim-two", time.Now()))
}

func TestChangeSourceRejectsEveryoneButTheController(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	e := sourceRoom(t, cfg, store)
	RegisterSourceRoute(e.Group("/api"), store, cfg, testMemberAuthorizer{allowed: true}, SourceHooks{})

	// A connected member who is not the controller holds a valid capability
	// but must not be able to replace what everyone is watching.
	require.NoError(t, store.SetController(t.Context(), "r1", "m9"))
	w := postSource(t, e, "r1", `{"memberId":"m1","capability":"secret-capability","kind":"screen"}`)
	require.Equal(t, http.StatusForbidden, w.Code)
	require.Contains(t, w.Body.String(), "not_controller")

	got, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, room.SourceUpload, got.SourceKind)
	require.FileExists(t, filepath.Join(cfg.DataDir, "rooms", "r1", "original.mkv"))
}

func TestChangeSourceRejectsBadInput(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	e := sourceRoom(t, cfg, store)
	RegisterSourceRoute(e.Group("/api"), store, cfg, testMemberAuthorizer{allowed: true}, SourceHooks{})

	tests := []struct {
		name string
		body string
		code int
	}{
		{name: "unknown kind", body: `{"memberId":"m1","capability":"secret-capability","kind":"webcam"}`, code: http.StatusBadRequest},
		{name: "upload without a file name", body: `{"memberId":"m1","capability":"secret-capability","kind":"upload"}`, code: http.StatusBadRequest},
		{name: "upload with a path", body: `{"memberId":"m1","capability":"secret-capability","kind":"upload","fileName":"../escape.mkv"}`, code: http.StatusBadRequest},
		{name: "no capability", body: `{"memberId":"m1","kind":"screen"}`, code: http.StatusBadRequest},
		{name: "wrong capability", body: `{"memberId":"m1","capability":"guessed","kind":"screen"}`, code: http.StatusForbidden},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			require.Equal(t, tt.code, postSource(t, e, "r1", tt.body).Code)
		})
	}
	// None of the rejections may have touched the media.
	require.FileExists(t, filepath.Join(cfg.DataDir, "rooms", "r1", "original.mkv"))
}

func TestChangeSourceMissingRoom(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	e := gin.New()
	RegisterSourceRoute(e.Group("/api"), store, cfg, testMemberAuthorizer{allowed: true}, SourceHooks{})

	w := postSource(t, e, "r1", `{"memberId":"m1","capability":"secret-capability","kind":"screen"}`)
	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestCreateScreenRoomNeedsNoFile(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	e := gin.New()
	RegisterRoomRoutes(e.Group("/api"), store, cfg)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/rooms", strings.NewReader(`{"kind":"screen","nickname":"giuli"}`))
	req.Header.Set("Content-Type", "application/json")
	e.ServeHTTP(w, req)

	require.Equal(t, http.StatusCreated, w.Code)
	require.Contains(t, w.Body.String(), `"sourceKind":"screen"`)
	require.Contains(t, w.Body.String(), `"status":"ready"`)
}

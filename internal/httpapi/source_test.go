package httpapi

import (
	"encoding/json"
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

func sourceRoom(t *testing.T, cfg config.Config, store *room.Store) *gin.Engine {
	t.Helper()
	now := time.Now()
	require.NoError(t, store.CreateWithMember(t.Context(), &room.Room{
		ID: "r1", FileName: "first.mkv", Status: "ready", OwnerToken: "owner-secret",
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

func TestChangeSourceToUploadReopensTheUploadWindow(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	e := sourceRoom(t, cfg, store)
	require.NoError(t, store.SetStatus(t.Context(), "r1", "uploading"))
	require.NoError(t, store.ReserveUpload(t.Context(), "r1", "claim-one", time.Now()))

	canceled := make([]string, 0, 1)
	var notified, reset []string
	RegisterSourceRoute(e.Group("/api"), store, cfg, testMemberAuthorizer{allowed: true}, SourceHooks{
		CancelMedia:   func(roomID string) { canceled = append(canceled, roomID) },
		NotifyStatus:  func(_, status string) { notified = append(notified, status) },
		ResetPlayback: func(id string) { reset = append(reset, id) },
	})

	w := postSource(t, e, "r1", `{"memberId":"m1","capability":"secret-capability","kind":"upload","fileName":"second.mkv"}`)
	require.Equal(t, http.StatusOK, w.Code)
	require.NotContains(t, w.Body.String(), "sourceKind")

	got, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, "uploading", got.Status)
	require.Equal(t, "second.mkv", got.FileName)
	require.Equal(t, 1, got.MediaGeneration)
	require.Equal(t, "m1", got.SourceMemberID)
	require.Empty(t, got.AudioTracks)
	require.Empty(t, got.SubtitleTracks)
	require.NoDirExists(t, filepath.Join(cfg.DataDir, "rooms", "r1"))
	require.Equal(t, []string{"r1"}, canceled)
	require.Equal(t, []string{"uploading"}, notified)
	require.Equal(t, []string{"r1"}, reset)

	require.NoError(t, store.ReserveUpload(t.Context(), "r1", "claim-two", time.Now()))
}

func TestChangeSourceLeavesTheScreensAndTheLiveUp(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	e := sourceRoom(t, cfg, store)
	require.NoError(t, store.StartScreenShare(t.Context(), "r1", room.ScreenShare{MemberID: "m2", Since: time.Now()}))
	require.NoError(t, store.SetLive(t.Context(), "r1", &room.LiveInfo{VideoID: "v", Broadcast: "b", Status: "ready"}))
	var liveCanceled []string
	RegisterSourceRoute(e.Group("/api"), store, cfg, testMemberAuthorizer{allowed: true}, SourceHooks{
		CancelLive: func(roomID string) { liveCanceled = append(liveCanceled, roomID) },
	})

	w := postSource(t, e, "r1", `{"memberId":"m1","capability":"secret-capability","kind":"youtube","fileName":"A/B test"}`)
	require.Equal(t, http.StatusOK, w.Code)

	got, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Len(t, got.Screens, 1)
	require.NotNil(t, got.Live)
	require.Empty(t, liveCanceled)
}

func TestAGrantedGuestOpensTheMediaAndHoldsIt(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	e := sourceRoom(t, cfg, store)
	var used []string
	RegisterSourceRoute(e.Group("/api"), store, cfg, testMemberAuthorizer{
		allowed: true, stages: map[string]bool{"m2/media": true}, used: &used,
	}, SourceHooks{})

	w := postSource(t, e, "r1", `{"memberId":"m2","capability":"secret-capability","kind":"upload","fileName":"guest.mkv"}`)
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, []string{"m2/media"}, used, "opening spends the grant")

	got, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, "m2", got.SourceMemberID)
	require.Equal(t, "m1", got.ControllerID)
}

func TestChangeSourceRejectsAMemberWithoutAGrant(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	e := sourceRoom(t, cfg, store)
	RegisterSourceRoute(e.Group("/api"), store, cfg, testMemberAuthorizer{allowed: true}, SourceHooks{})

	w := postSource(t, e, "r1", `{"memberId":"m2","capability":"secret-capability","kind":"upload","fileName":"x.mkv"}`)
	require.Equal(t, http.StatusForbidden, w.Code)
	require.Contains(t, w.Body.String(), "stage_not_granted")

	got, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, "first.mkv", got.FileName)
	require.FileExists(t, filepath.Join(cfg.DataDir, "rooms", "r1", "original.mkv"))
}

// The room's creator opens its first media before the room has seated them,
// with the token that proves they made it.
func TestTheOwnerTokenOpensMediaWithoutASeat(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	e := sourceRoom(t, cfg, store)
	RegisterSourceRoute(e.Group("/api"), store, cfg, testMemberAuthorizer{allowed: true}, SourceHooks{})

	w := postSource(t, e, "r1", `{"ownerToken":"not-it","kind":"upload","fileName":"x.mkv"}`)
	require.Equal(t, http.StatusForbidden, w.Code)

	w = postSource(t, e, "r1", `{"ownerToken":"owner-secret","kind":"upload","fileName":"x.mkv"}`)
	require.Equal(t, http.StatusOK, w.Code)
	var resp struct {
		Status          string `json:"status"`
		MediaGeneration int    `json:"mediaGeneration"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	require.Equal(t, "uploading", resp.Status)
	require.Equal(t, 1, resp.MediaGeneration)
	got, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, "m1", got.SourceMemberID)
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
		{name: "a screen is not a media source", body: `{"memberId":"m1","capability":"secret-capability","kind":"screen"}`, code: http.StatusBadRequest},
		{name: "upload without a file name", body: `{"memberId":"m1","capability":"secret-capability","kind":"upload"}`, code: http.StatusBadRequest},
		{name: "upload with a path", body: `{"memberId":"m1","capability":"secret-capability","kind":"upload","fileName":"../escape.mkv"}`, code: http.StatusBadRequest},
		{name: "no proof at all", body: `{"memberId":"m1","kind":"upload","fileName":"x.mkv"}`, code: http.StatusForbidden},
		{name: "wrong capability", body: `{"memberId":"m1","capability":"guessed","kind":"upload","fileName":"x.mkv"}`, code: http.StatusForbidden},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			require.Equal(t, tt.code, postSource(t, e, "r1", tt.body).Code)
		})
	}
	require.FileExists(t, filepath.Join(cfg.DataDir, "rooms", "r1", "original.mkv"))
}

func TestClosingTheMediaEmptiesItsStageOnly(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	sourceRoom(t, cfg, store)
	require.NoError(t, store.StartScreenShare(t.Context(), "r1", room.ScreenShare{MemberID: "m2", Since: time.Now()}))
	require.NoError(t, store.SetLive(t.Context(), "r1", &room.LiveInfo{VideoID: "v", Broadcast: "b", Status: "ready"}))
	var canceled, liveCanceled, statuses, reset []string
	hooks := SourceHooks{
		CancelMedia:   func(id string) { canceled = append(canceled, id) },
		CancelLive:    func(id string) { liveCanceled = append(liveCanceled, id) },
		NotifyStatus:  func(_, status string) { statuses = append(statuses, status) },
		ResetPlayback: func(id string) { reset = append(reset, id) },
	}

	require.NoError(t, CloseStage(t.Context(), store, cfg, hooks, "r1", room.StageMedia))
	got, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, room.StatusEmpty, got.Status)
	require.False(t, got.HasMedia())
	require.Empty(t, got.FileName)
	require.Empty(t, got.SourceMemberID)
	require.Equal(t, 1, got.MediaGeneration)
	require.Len(t, got.Screens, 1)
	require.NotNil(t, got.Live)
	require.NoDirExists(t, filepath.Join(cfg.DataDir, "rooms", "r1"))
	require.Equal(t, []string{"r1"}, canceled)
	require.Empty(t, liveCanceled)
	require.Equal(t, []string{room.StatusEmpty}, statuses)
	require.Equal(t, []string{"r1"}, reset)
}

func TestClosingTheLiveLeavesTheMedia(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	sourceRoom(t, cfg, store)
	require.NoError(t, store.SetLive(t.Context(), "r1", &room.LiveInfo{VideoID: "v", Broadcast: "b", Status: "ready"}))
	var canceled, liveCanceled, updated []string
	hooks := SourceHooks{
		CancelMedia:       func(id string) { canceled = append(canceled, id) },
		CancelLive:        func(id string) { liveCanceled = append(liveCanceled, id) },
		NotifyRoomUpdated: func(id string) { updated = append(updated, id) },
	}

	require.NoError(t, CloseStage(t.Context(), store, cfg, hooks, "r1", room.StageLive))
	got, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Nil(t, got.Live)
	require.Equal(t, "ready", got.Status)
	require.Equal(t, "first.mkv", got.FileName)
	require.Empty(t, canceled)
	require.Equal(t, []string{"r1"}, liveCanceled)
	require.Equal(t, []string{"r1"}, updated)
}

func TestTheHostOpensALocalSourceFromTheApp(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	e := sourceRoom(t, cfg, store)
	var notified, reset []string
	RegisterSourceRoute(e.Group("/api"), store, cfg, testMemberAuthorizer{allowed: true}, SourceHooks{
		NotifyStatus:  func(_, status string) { notified = append(notified, status) },
		ResetPlayback: func(id string) { reset = append(reset, id) },
	})

	w := postSource(t, e, "r1", `{"memberId":"m1","capability":"secret-capability","kind":"local","title":"Duna: Parte 2","durationMs":9960000}`)

	require.Equal(t, http.StatusOK, w.Code)
	var resp struct {
		Status          string `json:"status"`
		MediaGeneration int    `json:"mediaGeneration"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	require.Equal(t, room.StatusLocal, resp.Status)
	require.Equal(t, 1, resp.MediaGeneration)
	got, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, room.StatusLocal, got.Status)
	require.True(t, got.LocalSource)
	require.Equal(t, "Duna: Parte 2", got.FileName)
	require.Equal(t, int64(9_960_000), got.DurationMs)
	require.Equal(t, "m1", got.SourceMemberID)
	require.Equal(t, []string{room.StatusLocal}, notified)
	require.Equal(t, []string{"r1"}, reset)
}

func TestALocalSourceIsTheHostsAlone(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	e := sourceRoom(t, cfg, store)
	RegisterSourceRoute(e.Group("/api"), store, cfg, testMemberAuthorizer{
		allowed: true, stages: map[string]bool{"m2/media": true},
	}, SourceHooks{})

	tests := []struct {
		name string
		body string
		code int
	}{
		{name: "a granted guest", body: `{"memberId":"m2","capability":"secret-capability","kind":"local","title":"Filme"}`, code: http.StatusForbidden},
		{name: "without a title", body: `{"memberId":"m1","capability":"secret-capability","kind":"local"}`, code: http.StatusBadRequest},
		{name: "a negative duration", body: `{"memberId":"m1","capability":"secret-capability","kind":"local","title":"Filme","durationMs":-1}`, code: http.StatusBadRequest},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			require.Equal(t, tt.code, postSource(t, e, "r1", tt.body).Code)
		})
	}
	got, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, "first.mkv", got.FileName)
}

func postPromote(t *testing.T, e *gin.Engine, body string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/rooms/r1/local/promote", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	e.ServeHTTP(w, req)
	return w
}

func TestPromoteHandsTheAppAClaimWithoutRestartingTheRoom(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	e := sourceRoom(t, cfg, store)
	var notified []string
	RegisterSourceRoute(e.Group("/api"), store, cfg, testMemberAuthorizer{allowed: true}, SourceHooks{
		NotifyStatus: func(_, status string) { notified = append(notified, status) },
	})
	require.Equal(t, http.StatusOK, postSource(t, e, "r1", `{"memberId":"m1","capability":"secret-capability","kind":"local","title":"Filme"}`).Code)
	notified = nil
	clock := room.PlayState{Playing: true, PositionMs: 1_800_000, Rate: 1, ServerTimeMs: 7}
	require.NoError(t, store.SetState(t.Context(), "r1", clock))

	w := postPromote(t, e, `{"memberId":"m1","capability":"secret-capability"}`)

	require.Equal(t, http.StatusOK, w.Code)
	var resp clientClaimResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	require.True(t, strings.HasPrefix(resp.Claim, "client:"))
	require.True(t, strings.HasPrefix(resp.MetadataToken, "meta:"))
	require.Equal(t, 1, resp.MediaGeneration)
	require.Equal(t, maxClientBytes(cfg), resp.MaxBytes)
	held, err := store.UploadID(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, resp.Claim, held)
	got, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, room.StatusUploading, got.Status)
	require.Equal(t, 1, got.MediaGeneration)
	state, err := store.GetState(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, clock, state)
	require.Equal(t, []string{room.StatusUploading}, notified)
}

func TestPromoteRefusals(t *testing.T) {
	tests := []struct {
		name  string
		local bool
		body  string
		code  int
	}{
		{name: "a guest", local: true, body: `{"memberId":"m2","capability":"secret-capability"}`, code: http.StatusForbidden},
		{name: "a wrong capability", local: true, body: `{"memberId":"m1","capability":"guessed"}`, code: http.StatusForbidden},
		{name: "a source that is not local", body: `{"memberId":"m1","capability":"secret-capability"}`, code: http.StatusConflict},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := testCfg(t)
			store := newTestStore(t)
			e := sourceRoom(t, cfg, store)
			RegisterSourceRoute(e.Group("/api"), store, cfg, testMemberAuthorizer{allowed: true}, SourceHooks{})
			if tt.local {
				require.Equal(t, http.StatusOK, postSource(t, e, "r1", `{"memberId":"m1","capability":"secret-capability","kind":"local","title":"Filme"}`).Code)
			}
			require.Equal(t, tt.code, postPromote(t, e, tt.body).Code)
			held, err := store.UploadID(t.Context(), "r1")
			require.NoError(t, err)
			require.Empty(t, held)
		})
	}
}

// The app that opened the source holds the cache: it is the one promoted,
// even after it handed the controls to someone who has nothing to upload.
func TestPromoteFollowsTheProducerAfterTheControlsMoved(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	e := sourceRoom(t, cfg, store)
	RegisterSourceRoute(e.Group("/api"), store, cfg, testMemberAuthorizer{allowed: true}, SourceHooks{})
	require.Equal(t, http.StatusOK, postSource(t, e, "r1", `{"memberId":"m1","capability":"secret-capability","kind":"local","title":"Filme"}`).Code)
	require.NoError(t, store.SetController(t.Context(), "r1", "m2"))

	require.Equal(t, http.StatusForbidden, postPromote(t, e, `{"memberId":"m2","capability":"secret-capability"}`).Code)
	require.Equal(t, http.StatusOK, postPromote(t, e, `{"memberId":"m1","capability":"secret-capability"}`).Code)
}

func TestChangeSourceMissingRoom(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	e := gin.New()
	RegisterSourceRoute(e.Group("/api"), store, cfg, testMemberAuthorizer{allowed: true}, SourceHooks{})

	w := postSource(t, e, "r1", `{"memberId":"m1","capability":"secret-capability","kind":"upload","fileName":"x.mkv"}`)
	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestALocalSourceCarriesWhatTheAppsOpenThemselves(t *testing.T) {
	// A magnet keeps its percent-encoding and an accented name, byte for byte.
	magnet := "magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=A%20Viagem%20de%20Chihiro%20%E2%80%93%20Dublado&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce"
	tests := []struct {
		name  string
		local room.LocalCopy
	}{
		{name: "a torrent's file", local: room.LocalCopy{Kind: "torrent", Magnet: magnet, Index: 3}},
		{name: "the first file of a torrent", local: room.LocalCopy{Kind: "torrent", Magnet: magnet}},
		{name: "a video's page", local: room.LocalCopy{Kind: "youtube", URL: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42", VideoID: "dQw4w9WgXcQ"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := testCfg(t)
			store := newTestStore(t)
			e := sourceRoom(t, cfg, store)
			RegisterSourceRoute(e.Group("/api"), store, cfg, testMemberAuthorizer{allowed: true}, SourceHooks{})
			RegisterRoomRoutes(e.Group("/api"), store, cfg, nil)
			body, err := json.Marshal(map[string]any{
				"memberId": "m1", "capability": "secret-capability", "kind": "local",
				"title": "A Viagem de Chihiro – 千と千尋", "localCopy": tt.local,
			})
			require.NoError(t, err)

			require.Equal(t, http.StatusOK, postSource(t, e, "r1", string(body)).Code)

			got, err := store.Get(t.Context(), "r1")
			require.NoError(t, err)
			require.Equal(t, &tt.local, got.LocalCopy)
			require.Equal(t, "A Viagem de Chihiro – 千と千尋", got.FileName)
			w := httptest.NewRecorder()
			e.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/rooms/r1", nil))
			require.Equal(t, http.StatusOK, w.Code)
			var info struct {
				LocalSource bool            `json:"localSource"`
				LocalCopy   *room.LocalCopy `json:"localCopy"`
			}
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &info))
			require.True(t, info.LocalSource)
			require.Equal(t, &tt.local, info.LocalCopy)
		})
	}
}

func TestTheNextSourceDropsTheLastOnesLocalCopy(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	e := sourceRoom(t, cfg, store)
	RegisterSourceRoute(e.Group("/api"), store, cfg, testMemberAuthorizer{allowed: true}, SourceHooks{})
	first := `{"memberId":"m1","capability":"secret-capability","kind":"local","title":"Um","localCopy":{"kind":"torrent","magnet":"magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10","index":1}}`
	require.Equal(t, http.StatusOK, postSource(t, e, "r1", first).Code)

	// An app too old to send one opens the next.
	second := `{"memberId":"m1","capability":"secret-capability","kind":"local","title":"Dois"}`
	require.Equal(t, http.StatusOK, postSource(t, e, "r1", second).Code)

	got, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Nil(t, got.LocalCopy)
	require.Equal(t, "Dois", got.FileName)
}

func TestALocalCopyNoAppWouldOpenIsRefused(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	e := sourceRoom(t, cfg, store)
	RegisterSourceRoute(e.Group("/api"), store, cfg, testMemberAuthorizer{allowed: true}, SourceHooks{})

	long := "magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=" + strings.Repeat("a", 4096)
	tests := []struct {
		name string
		kind string
		copy string
	}{
		{name: "on a file the server holds", kind: "file", copy: `{"kind":"torrent","magnet":"magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10"}`},
		{name: "of an unknown kind", kind: "local", copy: `{"kind":"file","url":"https://example.com/a.mkv"}`},
		{name: "a torrent without a magnet", kind: "local", copy: `{"kind":"torrent","magnet":"https://example.com/a.torrent"}`},
		{name: "a torrent with a negative file", kind: "local", copy: `{"kind":"torrent","magnet":"magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10","index":-1}`},
		{name: "a magnet past the limit", kind: "local", copy: `{"kind":"torrent","magnet":"` + long + `"}`},
		{name: "a torrent that also names a page", kind: "local", copy: `{"kind":"torrent","magnet":"magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10","url":"https://youtu.be/x"}`},
		{name: "a video over plain http", kind: "local", copy: `{"kind":"youtube","url":"http://www.youtube.com/watch?v=x","videoId":"x"}`},
		{name: "a video without its id", kind: "local", copy: `{"kind":"youtube","url":"https://www.youtube.com/watch?v=x"}`},
		{name: "a torrent without a hash", kind: "local", copy: `{"kind":"torrent","magnet":"magnet:?dn=x&tr=http://10.0.0.1/a"}`},
		{name: "a torrent with a hash that is not one", kind: "local", copy: `{"kind":"torrent","magnet":"magnet:?xt=urn:btih:abc"}`},
		{name: "a video on another site", kind: "local", copy: `{"kind":"youtube","url":"https://evil.example/watch?v=dQw4w9WgXcQ","videoId":"dQw4w9WgXcQ"}`},
		{name: "a video on a youtube name at another port", kind: "local", copy: `{"kind":"youtube","url":"https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ","videoId":"dQw4w9WgXcQ"}`},
		{name: "a video id that is not one", kind: "local", copy: `{"kind":"youtube","url":"https://youtu.be/x","videoId":"../../etc/x"}`},
		{name: "a video id past the limit", kind: "local", copy: `{"kind":"youtube","url":"https://youtu.be/x","videoId":"` + strings.Repeat("x", 65) + `"}`},
		{name: "a video that also names a magnet", kind: "local", copy: `{"kind":"youtube","url":"https://youtu.be/x","videoId":"x","magnet":"magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10"}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body := `{"memberId":"m1","capability":"secret-capability","kind":"` + tt.kind + `","title":"Filme","fileName":"a.mkv","localCopy":` + tt.copy + `}`
			require.Equal(t, http.StatusBadRequest, postSource(t, e, "r1", body).Code)
		})
	}
	got, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, "first.mkv", got.FileName)
	require.Nil(t, got.LocalCopy)
}

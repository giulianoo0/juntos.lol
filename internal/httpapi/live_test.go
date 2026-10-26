package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/remux"
	"github.com/giulianoo0/ss/internal/room"
)

func postLive(t *testing.T, e *gin.Engine, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	e.ServeHTTP(w, req)
	return w
}

type liveHooks struct {
	updated, statuses, canceledMedia, canceledLive, reset []string
}

func liveRoomWith(t *testing.T, authorizer testMemberAuthorizer) (*gin.Engine, *room.Store, *liveHooks) {
	t.Helper()
	cfg := testCfg(t)
	cfg.MoqRelayURL, cfg.MoqPublishToken, cfg.MoqSubscribeToken = "https://relay.test", "pub", "sub"
	store := newTestStore(t)
	e := sourceRoom(t, cfg, store)
	hooks := &liveHooks{}
	RegisterLiveRoutes(e.Group("/api"), store, cfg, authorizer, SourceHooks{
		NotifyStatus:      func(_, status string) { hooks.statuses = append(hooks.statuses, status) },
		NotifyRoomUpdated: func(id string) { hooks.updated = append(hooks.updated, id) },
		CancelMedia:       func(id string) { hooks.canceledMedia = append(hooks.canceledMedia, id) },
		CancelLive:        func(id string) { hooks.canceledLive = append(hooks.canceledLive, id) },
		ResetPlayback:     func(id string) { hooks.reset = append(hooks.reset, id) },
	}, nil)
	return e, store, hooks
}

func liveRoom(t *testing.T) (*gin.Engine, *room.Store, *liveHooks) {
	return liveRoomWith(t, testMemberAuthorizer{allowed: true})
}

func TestStartLiveOpensTheLiveBesideTheMedia(t *testing.T) {
	e, store, hooks := liveRoom(t)
	require.NoError(t, store.StartScreenShare(t.Context(), "r1", room.ScreenShare{MemberID: "m2", Since: time.Now()}))
	w := postLive(t, e, "/api/rooms/r1/live", `{"memberId":"m1","capability":"secret-capability","url":"https://youtu.be/36YnV9STBqc","producer":"jlocal","title":"Good Life Radio"}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	var body struct {
		Status    string `json:"status"`
		Broadcast string `json:"broadcast"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, "processing", body.Status)
	require.True(t, strings.HasSuffix(body.Broadcast, "/live.hang"))
	require.True(t, strings.HasPrefix(body.Broadcast, "juntos/r1/"))

	got, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, "ready", got.Status, "the media plays on")
	require.Equal(t, "first.mkv", got.FileName)
	require.Equal(t, 0, got.MediaGeneration)
	require.Len(t, got.Screens, 1)
	require.NotNil(t, got.Live)
	require.Equal(t, "36YnV9STBqc", got.Live.VideoID)
	require.Equal(t, "Good Life Radio", got.Live.Title)
	require.Equal(t, "jlocal", got.Live.Producer)
	require.Equal(t, "m1", got.Live.MemberID)
	require.Equal(t, "processing", got.Live.Status)
	require.Equal(t, body.Broadcast, got.Live.Broadcast)
	require.Equal(t, []string{"r1"}, hooks.canceledLive, "a new live replaces the old one")
	require.Empty(t, hooks.canceledMedia)
	require.Empty(t, hooks.reset)
	require.Empty(t, hooks.statuses)
	require.Equal(t, []string{"r1"}, hooks.updated)
}

func TestStartLiveOnTheFleetNeedsAWorkerService(t *testing.T) {
	e, _, _ := liveRoom(t)
	w := postLive(t, e, "/api/rooms/r1/live", `{"memberId":"m1","capability":"secret-capability","url":"https://youtu.be/36YnV9STBqc","producer":"fleet"}`)
	require.Equal(t, http.StatusServiceUnavailable, w.Code)
	require.Contains(t, w.Body.String(), "youtube_no_workers")
}

func TestStartLiveNeedsTheHostOrAGrant(t *testing.T) {
	e, _, _ := liveRoom(t)
	w := postLive(t, e, "/api/rooms/r1/live", `{"memberId":"m2","capability":"secret-capability","url":"https://youtu.be/36YnV9STBqc","producer":"jlocal"}`)
	require.Equal(t, http.StatusForbidden, w.Code)

	var used []string
	e, store, _ := liveRoomWith(t, testMemberAuthorizer{allowed: true, stages: map[string]bool{"m2/live": true}, used: &used})
	w = postLive(t, e, "/api/rooms/r1/live", `{"memberId":"m2","capability":"secret-capability","url":"https://youtu.be/36YnV9STBqc","producer":"jlocal"}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, []string{"m2/live"}, used)
	got, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, "m2", got.Live.MemberID)
}

func TestLiveStateFollowsTheCompanionProducer(t *testing.T) {
	e, store, hooks := liveRoom(t)
	require.Equal(t, http.StatusOK, postLive(t, e, "/api/rooms/r1/live", `{"memberId":"m1","capability":"secret-capability","url":"https://youtu.be/36YnV9STBqc","producer":"jlocal"}`).Code)

	w := postLive(t, e, "/api/rooms/r1/live/state", `{"memberId":"m2","capability":"secret-capability","state":"live"}`)
	require.Equal(t, http.StatusForbidden, w.Code, "only the live's owner or the host reports for it")

	w = postLive(t, e, "/api/rooms/r1/live/state", `{"memberId":"m1","capability":"secret-capability","state":"live"}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	got, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, "ready", got.Live.Status)
	require.Equal(t, "ready", got.Status, "the media's status is its own")

	w = postLive(t, e, "/api/rooms/r1/live/state", `{"memberId":"m1","capability":"secret-capability","state":"ended"}`)
	require.Equal(t, http.StatusOK, w.Code)
	got, err = store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, "error", got.Live.Status)
	require.Equal(t, "live_ended", got.Live.Error)
	require.Equal(t, "ready", got.Status)
	require.Empty(t, got.ErrorMessage)
	require.Len(t, hooks.updated, 3)
	require.Empty(t, hooks.statuses)
}

func TestLiveReporterIgnoresAWorkerThatIsNotTheProducer(t *testing.T) {
	_, store, _ := liveRoom(t)
	require.NoError(t, store.SetLive(t.Context(), "r1", &room.LiveInfo{VideoID: "v", Producer: "fleet", WorkerID: "w_1", Broadcast: "juntos/r1/s/live.hang", Status: "processing"}))
	var updated []string
	report := LiveReporter(store, func(id string) { updated = append(updated, id) })

	report("r1", "w_other", remux.LiveState{State: "live"})
	got, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, "processing", got.Live.Status)

	report("r1", "w_1", remux.LiveState{State: "live"})
	got, err = store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, "ready", got.Live.Status)

	report("r1", "w_1", remux.LiveState{State: "failed", Code: "youtube_unavailable"})
	got, err = store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, "error", got.Live.Status)
	require.Equal(t, "youtube_unavailable", got.Live.Error)
	require.Equal(t, "ready", got.Status)
	require.Equal(t, []string{"r1", "r1"}, updated)
}

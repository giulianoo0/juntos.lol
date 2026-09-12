package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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

func liveRoom(t *testing.T) (*gin.Engine, *room.Store, *[]string) {
	t.Helper()
	cfg := testCfg(t)
	cfg.MoqRelayURL, cfg.MoqPublishToken, cfg.MoqSubscribeToken = "https://relay.test", "pub", "sub"
	store := newTestStore(t)
	e := sourceRoom(t, cfg, store)
	notified := &[]string{}
	RegisterLiveRoutes(e.Group("/api"), store, cfg, testMemberAuthorizer{allowed: true}, SourceHooks{
		NotifyStatus: func(_, status string) { *notified = append(*notified, status) },
	}, nil)
	return e, store, notified
}

func TestStartLiveTurnsTheRoomIntoALiveRoom(t *testing.T) {
	e, store, notified := liveRoom(t)
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
	require.Equal(t, room.SourceLive, got.SourceKind)
	require.Equal(t, "processing", got.Status)
	require.Equal(t, "Good Life Radio", got.FileName)
	require.Equal(t, 1, got.MediaGeneration)
	require.NotNil(t, got.Live)
	require.Equal(t, "36YnV9STBqc", got.Live.VideoID)
	require.Equal(t, "jlocal", got.Live.Producer)
	require.Equal(t, body.Broadcast, got.Live.Broadcast)
	require.Equal(t, []string{"processing"}, *notified)
}

func TestStartLiveOnTheFleetNeedsAWorkerService(t *testing.T) {
	e, _, _ := liveRoom(t)
	w := postLive(t, e, "/api/rooms/r1/live", `{"memberId":"m1","capability":"secret-capability","url":"https://youtu.be/36YnV9STBqc","producer":"fleet"}`)
	require.Equal(t, http.StatusServiceUnavailable, w.Code)
	require.Contains(t, w.Body.String(), "youtube_no_workers")
}

func TestStartLiveIsTheControllersAlone(t *testing.T) {
	e, _, _ := liveRoom(t)
	w := postLive(t, e, "/api/rooms/r1/live", `{"memberId":"m2","capability":"secret-capability","url":"https://youtu.be/36YnV9STBqc","producer":"jlocal"}`)
	require.Equal(t, http.StatusForbidden, w.Code)
}

func TestLiveStateFollowsTheCompanionProducer(t *testing.T) {
	e, store, notified := liveRoom(t)
	require.Equal(t, http.StatusOK, postLive(t, e, "/api/rooms/r1/live", `{"memberId":"m1","capability":"secret-capability","url":"https://youtu.be/36YnV9STBqc","producer":"jlocal"}`).Code)

	w := postLive(t, e, "/api/rooms/r1/live/state", `{"memberId":"m1","capability":"secret-capability","state":"live"}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	got, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, "ready", got.Status)

	w = postLive(t, e, "/api/rooms/r1/live/state", `{"memberId":"m1","capability":"secret-capability","state":"ended"}`)
	require.Equal(t, http.StatusOK, w.Code)
	got, err = store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, "error", got.Status)
	require.Equal(t, "live_ended", got.ErrorMessage)
	require.Equal(t, []string{"processing", "ready", "error"}, *notified)
}

func TestLiveReporterIgnoresAWorkerThatIsNotTheProducer(t *testing.T) {
	_, store, notified := liveRoom(t)
	require.NoError(t, store.SwapSourceForTest(t.Context(), "r1"))
	require.NoError(t, store.SetLive(t.Context(), "r1", &room.LiveInfo{VideoID: "v", Producer: "fleet", WorkerID: "w_1", Broadcast: "juntos/r1/s/live.hang"}))
	report := LiveReporter(store, func(_, status string) { *notified = append(*notified, status) })

	report("r1", "w_other", remux.LiveState{State: "live"})
	got, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, "processing", got.Status)

	report("r1", "w_1", remux.LiveState{State: "live"})
	got, err = store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, "ready", got.Status)

	report("r1", "w_1", remux.LiveState{State: "failed", Code: "youtube_unavailable"})
	got, err = store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, "error", got.Status)
	require.Equal(t, "youtube_unavailable", got.ErrorMessage)
	require.Equal(t, []string{"ready", "error"}, *notified)
}

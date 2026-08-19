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
	"github.com/giulianoo0/ss/internal/torrent"
)

type fakeIngestor struct {
	enabled bool
	jobs    []torrent.Job
	err     error
}

func (f *fakeIngestor) Enabled() bool { return f.enabled }

func (f *fakeIngestor) Submit(job torrent.Job) error {
	if f.err != nil {
		return f.err
	}
	f.jobs = append(f.jobs, job)
	return nil
}

func torrentEngine(t *testing.T, ingestor TorrentIngestor) (*gin.Engine, *room.Store) {
	t.Helper()
	s := newTestStore(t)
	e := gin.New()
	RegisterTorrentRoute(e.Group("/api"), s, testCfg(t), ingestor)
	return e, s
}

func newUploadingRoom(t *testing.T, s *room.Store, id string) {
	t.Helper()
	require.NoError(t, s.Create(context.Background(), &room.Room{
		ID: id, FileName: "movie.mkv", Status: "uploading", SourceKind: room.SourceUpload,
		ControllerID: "m1", CreatedAt: time.Now(), ExpiresAt: time.Now().Add(time.Hour),
	}))
}

func postTorrent(t *testing.T, e *gin.Engine, id, body string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/rooms/"+id+"/torrent", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	e.ServeHTTP(w, req)
	return w
}

const validTorrentBody = `{"sessionId":"1a2b-3c","path":"show/episode.mkv","fileName":"episode.mkv","size":1048576}`

func TestIngestTorrentHandsTheFileToTheServer(t *testing.T) {
	ingestor := &fakeIngestor{enabled: true}
	e, s := torrentEngine(t, ingestor)
	newUploadingRoom(t, s, "room1234")

	w := postTorrent(t, e, "room1234", validTorrentBody)
	require.Equal(t, http.StatusAccepted, w.Code)
	require.Len(t, ingestor.jobs, 1)
	require.Equal(t, torrent.Job{
		RoomID: "room1234", SessionID: "1a2b-3c", Path: "show/episode.mkv",
		FileName: "episode.mkv", Size: 1 << 20,
	}, ingestor.jobs[0])

	// The size is recorded before a byte arrives, so the waiting screen has
	// something to measure against immediately.
	stored, err := s.Get(context.Background(), "room1234")
	require.NoError(t, err)
	require.Equal(t, int64(1<<20), stored.Preparation.SourceBytes)
	require.Equal(t, room.PreviewReceiving, stored.Preparation.PreviewPhase)
}

func TestIngestTorrentRouteAbsentWithoutAnIngestor(t *testing.T) {
	// A deployment with no bridge must answer 404 here, because that is the
	// signal the browser falls back on rather than reporting a failure.
	e, s := torrentEngine(t, &fakeIngestor{enabled: false})
	newUploadingRoom(t, s, "room1234")

	require.Equal(t, http.StatusNotFound, postTorrent(t, e, "room1234", validTorrentBody).Code)
}

func TestIngestTorrentRejectsARoomNotWaitingForOne(t *testing.T) {
	ingestor := &fakeIngestor{enabled: true}
	e, s := torrentEngine(t, ingestor)
	newUploadingRoom(t, s, "room1234")
	require.NoError(t, s.SetStatus(context.Background(), "room1234", "ready"))

	require.Equal(t, http.StatusForbidden, postTorrent(t, e, "room1234", validTorrentBody).Code)
	require.Empty(t, ingestor.jobs)
}

func TestIngestTorrentRefusesASecondTransfer(t *testing.T) {
	ingestor := &fakeIngestor{enabled: true}
	e, s := torrentEngine(t, ingestor)
	newUploadingRoom(t, s, "room1234")
	require.NoError(t, s.ReserveUpload(context.Background(), "room1234", "upload1", time.Now()))

	require.Equal(t, http.StatusConflict, postTorrent(t, e, "room1234", validTorrentBody).Code)
	require.Empty(t, ingestor.jobs)
}

func TestIngestTorrentReportsABusyIngest(t *testing.T) {
	e, s := torrentEngine(t, &fakeIngestor{enabled: true, err: torrent.ErrBusy})
	newUploadingRoom(t, s, "room1234")

	require.Equal(t, http.StatusServiceUnavailable, postTorrent(t, e, "room1234", validTorrentBody).Code)
}

func TestIngestTorrentMissingRoom(t *testing.T) {
	e, _ := torrentEngine(t, &fakeIngestor{enabled: true})
	require.Equal(t, http.StatusNotFound, postTorrent(t, e, "nosuchrm", validTorrentBody).Code)
}

func TestIngestTorrentRejectsUnusableRequests(t *testing.T) {
	cases := map[string]string{
		"empty session":            `{"sessionId":"","path":"a.mkv","fileName":"a.mkv","size":10}`,
		"session with path":        `{"sessionId":"../x","path":"a.mkv","fileName":"a.mkv","size":10}`,
		"file name with directory": `{"sessionId":"s1","path":"a.mkv","fileName":"../a.mkv","size":10}`,
		"zero size":                `{"sessionId":"s1","path":"a.mkv","fileName":"a.mkv","size":0}`,
		"negative size":            `{"sessionId":"s1","path":"a.mkv","fileName":"a.mkv","size":-5}`,
		"beyond the cap":           `{"sessionId":"s1","path":"a.mkv","fileName":"a.mkv","size":99999999999999}`,
		"not json":                 `nope`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			ingestor := &fakeIngestor{enabled: true}
			e, s := torrentEngine(t, ingestor)
			newUploadingRoom(t, s, "room1234")

			require.Equal(t, http.StatusBadRequest, postTorrent(t, e, "room1234", body).Code)
			require.Empty(t, ingestor.jobs)
		})
	}
}

func TestRoomExposesItsPreparation(t *testing.T) {
	s := newTestStore(t)
	e := gin.New()
	RegisterRoomRoutes(e.Group("/api"), s, testCfg(t))
	newUploadingRoom(t, s, "room1234")
	ctx := context.Background()
	require.NoError(t, s.SetIngestProgress(ctx, "room1234", 5<<20, 100<<20))
	require.NoError(t, s.SetPreviewPhase(ctx, "room1234", room.PreviewSegmenting, 20<<20))

	w := httptest.NewRecorder()
	e.ServeHTTP(w, httptest.NewRequest("GET", "/api/rooms/room1234", nil))
	require.Equal(t, http.StatusOK, w.Code)

	var resp struct {
		Preparation room.Preparation `json:"preparation"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	require.Equal(t, room.Preparation{
		SourceBytes:        100 << 20,
		ReceivedBytes:      5 << 20,
		PreviewPhase:       room.PreviewSegmenting,
		PreviewTargetBytes: 20 << 20,
	}, resp.Preparation)
}

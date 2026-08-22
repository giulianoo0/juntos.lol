package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/room"
	"github.com/giulianoo0/ss/internal/urlingest"
)

type fakeURLIngestor struct {
	enabled bool
	jobs    []urlingest.Job
	err     error
}

func (f *fakeURLIngestor) Enabled() bool { return f.enabled }

func (f *fakeURLIngestor) Submit(job urlingest.Job) error {
	if f.err != nil {
		return f.err
	}
	f.jobs = append(f.jobs, job)
	return nil
}

func urlEngine(t *testing.T, ingestor URLIngestor) (*gin.Engine, *room.Store) {
	t.Helper()
	s := newTestStore(t)
	e := gin.New()
	RegisterURLSourceRoute(e.Group("/api"), s, testCfg(t), ingestor)
	return e, s
}

func postURL(t *testing.T, e *gin.Engine, id, body string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/rooms/"+id+"/url", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	e.ServeHTTP(w, req)
	return w
}

const validURLBody = `{"url":"https://cdn.example.com/movie.mkv","fileName":"movie.mkv","size":1048576}`

func TestIngestURLHandsTheSourceToTheServer(t *testing.T) {
	ingestor := &fakeURLIngestor{enabled: true}
	e, s := urlEngine(t, ingestor)
	newUploadingRoom(t, s, "roomurl1")

	w := postURL(t, e, "roomurl1", validURLBody)

	require.Equal(t, http.StatusAccepted, w.Code, w.Body.String())
	require.Len(t, ingestor.jobs, 1)
	require.Equal(t, "https://cdn.example.com/movie.mkv", ingestor.jobs[0].URL)
	require.Equal(t, "roomurl1", ingestor.jobs[0].RoomID)
	require.Equal(t, int64(1048576), ingestor.jobs[0].Size)
}

// A stream carrying a url almost never carries a byte count, so zero has to be
// a legitimate value rather than a validation failure.
func TestIngestURLAcceptsAnUnknownSize(t *testing.T) {
	ingestor := &fakeURLIngestor{enabled: true}
	e, s := urlEngine(t, ingestor)
	newUploadingRoom(t, s, "roomurl2")

	w := postURL(t, e, "roomurl2", `{"url":"https://cdn.example.com/m.mkv","fileName":"m.mkv","size":0}`)

	require.Equal(t, http.StatusAccepted, w.Code, w.Body.String())
	require.Equal(t, int64(0), ingestor.jobs[0].Size)
}

// The guard's own tests cover every shape of address; this one proves the
// route asks it at all, and answers with the reason rather than a bare 400.
func TestIngestURLRefusesAnUnsafeSource(t *testing.T) {
	for name, body := range map[string]string{
		"plain http": `{"url":"http://cdn.example.com/m.mkv","fileName":"m.mkv","size":1024}`,
		"loopback":   `{"url":"https://127.0.0.1/m.mkv","fileName":"m.mkv","size":1024}`,
		"private":    `{"url":"https://192.168.1.9/m.mkv","fileName":"m.mkv","size":1024}`,
		"localhost":  `{"url":"https://localhost/m.mkv","fileName":"m.mkv","size":1024}`,
		"creds":      `{"url":"https://a:b@cdn.example.com/m.mkv","fileName":"m.mkv","size":1024}`,
	} {
		t.Run(name, func(t *testing.T) {
			ingestor := &fakeURLIngestor{enabled: true}
			e, s := urlEngine(t, ingestor)
			newUploadingRoom(t, s, "roomurl3")

			w := postURL(t, e, "roomurl3", body)

			require.Equal(t, http.StatusBadRequest, w.Code)
			require.Contains(t, w.Body.String(), "reason")
			require.Empty(t, ingestor.jobs)
		})
	}
}

func TestIngestURLRouteAbsentWithoutAnIngestor(t *testing.T) {
	e, s := urlEngine(t, &fakeURLIngestor{enabled: false})
	newUploadingRoom(t, s, "roomurl4")

	require.Equal(t, http.StatusNotFound, postURL(t, e, "roomurl4", validURLBody).Code)
}

func TestIngestURLRejectsARoomNotWaitingForOne(t *testing.T) {
	ingestor := &fakeURLIngestor{enabled: true}
	e, s := urlEngine(t, ingestor)
	newUploadingRoom(t, s, "roomurl5")
	require.NoError(t, s.SetStatus(context.Background(), "roomurl5", "ready"))

	require.Equal(t, http.StatusForbidden, postURL(t, e, "roomurl5", validURLBody).Code)
	require.Empty(t, ingestor.jobs)
}

func TestIngestURLReportsABusyIngest(t *testing.T) {
	e, s := urlEngine(t, &fakeURLIngestor{enabled: true, err: urlingest.ErrBusy})
	newUploadingRoom(t, s, "roomurl6")

	require.Equal(t, http.StatusServiceUnavailable, postURL(t, e, "roomurl6", validURLBody).Code)
}

func TestIngestURLMissingRoom(t *testing.T) {
	e, _ := urlEngine(t, &fakeURLIngestor{enabled: true})
	require.Equal(t, http.StatusNotFound, postURL(t, e, "nosuchrm", validURLBody).Code)
}

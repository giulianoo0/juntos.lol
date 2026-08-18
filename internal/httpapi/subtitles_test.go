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

	"github.com/giulianoo0/ss/internal/room"
)

const validVTT = "WEBVTT\n\n00:00.000 --> 00:02.000\nhello\n"

func postSubtitles(t *testing.T, e *gin.Engine, roomID, body string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/rooms/"+roomID+"/subtitles", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	e.ServeHTTP(w, req)
	return w
}

func TestStoreClientSubtitlesHappyPath(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "r1", FileName: "movie.mkv", Status: "uploading", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
	stored := make(chan string, 1)
	e := gin.New()
	RegisterSubtitlesRoute(e.Group("/api"), store, cfg, func(id string) { stored <- id })

	body := `{"tracks":[` +
		`{"language":"eng","title":"Signs","vtt":` + strconvQuote(validVTT) + `},` +
		`{"language":"en us","title":"","vtt":` + strconvQuote(validVTT) + `}` +
		`]}`
	w := postSubtitles(t, e, "r1", body)

	require.Equal(t, http.StatusCreated, w.Code)
	select {
	case id := <-stored:
		require.Equal(t, "r1", id)
	case <-time.After(time.Second):
		t.Fatal("onSubsStored not called")
	}

	got, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.True(t, got.ClientSubs)
	require.Equal(t, []room.TrackInfo{
		{Index: 0, Language: "eng", Title: "Signs", Codec: "webvtt"},
		{Index: 1, Language: "und", Codec: "webvtt"},
	}, got.SubtitleTracks)

	for _, name := range []string{"sub_0_eng.vtt", "sub_1_und.vtt"} {
		data, err := os.ReadFile(filepath.Join(cfg.DataDir, "rooms", "r1", "subs", name))
		require.NoError(t, err)
		require.Equal(t, validVTT, string(data))
	}
}

func TestStoreClientSubtitlesMissingRoom(t *testing.T) {
	cfg := testCfg(t)
	e := gin.New()
	RegisterSubtitlesRoute(e.Group("/api"), newTestStore(t), cfg, nil)

	w := postSubtitles(t, e, "missing", `{"tracks":[{"language":"eng","vtt":"WEBVTT"}]}`)
	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestStoreClientSubtitlesExpiredRoom(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "expired", Status: "uploading", CreatedAt: now.Add(-2 * time.Hour), ExpiresAt: now.Add(-time.Minute),
	}))
	e := gin.New()
	RegisterSubtitlesRoute(e.Group("/api"), store, cfg, nil)

	w := postSubtitles(t, e, "expired", `{"tracks":[{"language":"eng","vtt":"WEBVTT"}]}`)
	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestStoreClientSubtitlesRejectsBadInput(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "r1", FileName: "movie.mkv", Status: "uploading", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
	e := gin.New()
	RegisterSubtitlesRoute(e.Group("/api"), store, cfg, nil)

	tests := []struct {
		name string
		body string
	}{
		{name: "not JSON", body: `{`},
		{name: "no tracks", body: `{"tracks":[]}`},
		{name: "vtt missing WEBVTT header", body: `{"tracks":[{"language":"eng","vtt":"not vtt"}]}`},
		{name: "title too long", body: `{"tracks":[{"language":"eng","title":"` + strings.Repeat("a", 256) + `","vtt":"WEBVTT"}]}`},
		{name: "too many tracks", body: `{"tracks":[` + strings.TrimSuffix(strings.Repeat(`{"language":"eng","vtt":"WEBVTT"},`, 33), ",") + `]}`},
		{name: "oversize body", body: `{"tracks":[{"language":"eng","vtt":"WEBVTT ` + strings.Repeat("a", 8<<20) + `"}]}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := postSubtitles(t, e, "r1", tt.body)
			require.Equal(t, http.StatusBadRequest, w.Code)
		})
	}
}

func strconvQuote(value string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range value {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

func TestStoreClientSubtitlesPartialKeepsServerExtraction(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "r2", FileName: "movie.mkv", Status: "uploading", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
	e := gin.New()
	RegisterSubtitlesRoute(e.Group("/api"), store, cfg, nil)

	body := `{"complete":false,"tracks":[{"language":"eng","title":"Signs","vtt":` + strconvQuote(validVTT) + `}]}`
	w := postSubtitles(t, e, "r2", body)
	require.Equal(t, http.StatusCreated, w.Code)

	// The cues are published so playback can already use them...
	got, err := store.Get(t.Context(), "r2")
	require.NoError(t, err)
	require.Equal(t, []room.TrackInfo{{Index: 0, Language: "eng", Title: "Signs", Codec: "webvtt"}}, got.SubtitleTracks)
	data, err := os.ReadFile(filepath.Join(cfg.DataDir, "rooms", "r2", "subs", "sub_0_eng.vtt"))
	require.NoError(t, err)
	require.Equal(t, validVTT, string(data))

	// ...but the authoritative ffmpeg pass must still run at upload completion.
	require.False(t, got.ClientSubs)
	has, err := store.HasClientSubs(t.Context(), "r2")
	require.NoError(t, err)
	require.False(t, has)

	// The finishing post promotes the same room to a completed extraction.
	w = postSubtitles(t, e, "r2", `{"complete":true,"tracks":[{"language":"eng","title":"Signs","vtt":`+strconvQuote(validVTT)+`}]}`)
	require.Equal(t, http.StatusCreated, w.Code)
	has, err = store.HasClientSubs(t.Context(), "r2")
	require.NoError(t, err)
	require.True(t, has)
}

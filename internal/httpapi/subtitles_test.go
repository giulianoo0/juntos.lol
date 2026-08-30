package httpapi

import (
	"context"
	"errors"
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
	RegisterSubtitlesRoute(e.Group("/api"), store, cfg, nil, func(id string) { stored <- id })

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
	digest := subtitleDigest(validVTT)
	require.NotEmpty(t, digest)
	require.Equal(t, []room.TrackInfo{
		{Index: 0, Language: "eng", Title: "Signs", Codec: "webvtt", Digest: digest},
		{Index: 1, Language: "und", Codec: "webvtt", Digest: digest},
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
	RegisterSubtitlesRoute(e.Group("/api"), newTestStore(t), cfg, nil, nil)

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
	RegisterSubtitlesRoute(e.Group("/api"), store, cfg, nil, nil)

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
	RegisterSubtitlesRoute(e.Group("/api"), store, cfg, nil, nil)

	tests := []struct {
		name string
		body string
	}{
		{name: "not JSON", body: `{`},
		{name: "no tracks", body: `{"tracks":[]}`},
		{name: "vtt missing WEBVTT header", body: `{"tracks":[{"language":"eng","vtt":"not vtt"}]}`},
		{name: "title too long", body: `{"tracks":[{"language":"eng","title":"` + strings.Repeat("a", 256) + `","vtt":"WEBVTT"}]}`},
		{name: "too many tracks", body: `{"tracks":[` + strings.TrimSuffix(strings.Repeat(`{"language":"eng","vtt":"WEBVTT"},`, maxSubtitleTracks+1), ",") + `]}`},
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
	RegisterSubtitlesRoute(e.Group("/api"), store, cfg, nil, nil)

	body := `{"complete":false,"tracks":[{"language":"eng","title":"Signs","vtt":` + strconvQuote(validVTT) + `}]}`
	w := postSubtitles(t, e, "r2", body)
	require.Equal(t, http.StatusCreated, w.Code)

	// The cues are published so playback can already use them...
	got, err := store.Get(t.Context(), "r2")
	require.NoError(t, err)
	require.Equal(t, []room.TrackInfo{
		{Index: 0, Language: "eng", Title: "Signs", Codec: "webvtt", Digest: subtitleDigest(validVTT)},
	}, got.SubtitleTracks)
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

// recordingSubtitlePublisher stands in for the bucket in handler tests.
type recordingSubtitlePublisher struct {
	dirs []string
	err  error
}

func (p *recordingSubtitlePublisher) PublishSubtitles(_ context.Context, _, subsDir string) error {
	p.dirs = append(p.dirs, subsDir)
	return p.err
}

func oneTrackBody() string {
	return `{"tracks":[{"language":"eng","title":"Signs","vtt":` + strconvQuote(validVTT) + `}]}`
}

func addSubtitlesTestRoom(t *testing.T, store *room.Store, id string) {
	t.Helper()
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: id, FileName: "movie.mkv", Status: "uploading", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
}

func TestStoreClientSubtitlesUploadsBeforeAnnouncing(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	addSubtitlesTestRoom(t, store, "r1")
	publisher := &recordingSubtitlePublisher{}
	e := gin.New()
	RegisterSubtitlesRoute(e.Group("/api"), store, cfg, publisher, nil)

	w := postSubtitles(t, e, "r1", oneTrackBody())

	require.Equal(t, http.StatusCreated, w.Code)
	require.Equal(t, []string{filepath.Join(cfg.DataDir, "rooms", "r1", "subs")}, publisher.dirs)
}

func TestStoreClientSubtitlesFailsWhenTheBucketRefuses(t *testing.T) {
	// Announcing tracks the bucket does not hold would point every connected
	// player at a subtitle URL that 404s.
	cfg := testCfg(t)
	store := newTestStore(t)
	addSubtitlesTestRoom(t, store, "r1")
	e := gin.New()
	RegisterSubtitlesRoute(e.Group("/api"), store, cfg,
		&recordingSubtitlePublisher{err: errors.New("bucket refused")}, nil)

	w := postSubtitles(t, e, "r1", oneTrackBody())

	require.Equal(t, http.StatusInternalServerError, w.Code)
	got, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Empty(t, got.SubtitleTracks, "tracks must not be announced without files behind them")
}

func TestStoreClientSubtitlesRejectsAnExtractionFromAReplacedSource(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "r1", FileName: "first.mkv", Status: "uploading", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
	// The controller swaps the room onto a second video. The browser is still
	// reading the first one — its extraction runs for as long as the file is
	// large — and finishes afterwards.
	_, generation, err := store.SwapSource(t.Context(), "r1", room.SourceUpload, "second.mkv", "uploading", now)
	require.NoError(t, err)
	require.Equal(t, 1, generation)

	e := gin.New()
	RegisterSubtitlesRoute(e.Group("/api"), store, cfg, nil, nil)
	body := `{"mediaGeneration":0,"tracks":[` +
		`{"language":"eng","title":"From the first video","vtt":` + strconvQuote(validVTT) + `}` +
		`]}`
	w := postSubtitles(t, e, "r1", body)

	// Accepting it would hand the new video the previous one's subtitles and,
	// worse, mark the room as having client subtitles: the server then skips
	// its own extraction and the new video never gets the right ones at all.
	require.Equal(t, http.StatusConflict, w.Code)
	got, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.False(t, got.ClientSubs)
	require.Empty(t, got.SubtitleTracks)
}

func TestStoreClientSubtitlesAcceptsTheCurrentGeneration(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "r1", FileName: "movie.mkv", Status: "uploading", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
	e := gin.New()
	RegisterSubtitlesRoute(e.Group("/api"), store, cfg, nil, nil)

	body := `{"mediaGeneration":0,"tracks":[` +
		`{"language":"eng","title":"Signs","vtt":` + strconvQuote(validVTT) + `}` +
		`]}`
	require.Equal(t, http.StatusCreated, postSubtitles(t, e, "r1", body).Code)
}

func TestStoreClientSubtitlesCarriesOverATrackWithNoNewBytes(t *testing.T) {
	// The extraction republishes every few seconds and most tracks are done
	// long before the pass is; sending them again costs the host's uplink,
	// which is the same one the remux is uploading segments on.
	cfg := testCfg(t)
	store := newTestStore(t)
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "r5", FileName: "movie.mkv", Status: "uploading", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
	e := gin.New()
	RegisterSubtitlesRoute(e.Group("/api"), store, cfg, nil, nil)

	first := `{"complete":false,"tracks":[` +
		`{"language":"eng","title":"Signs","vtt":` + strconvQuote(validVTT) + `},` +
		`{"language":"por","title":"","vtt":` + strconvQuote(validVTT) + `}` +
		`]}`
	require.Equal(t, http.StatusCreated, postSubtitles(t, e, "r5", first).Code)

	path := filepath.Join(cfg.DataDir, "rooms", "r5", "subs", "sub_0_eng.vtt")
	before, err := os.Stat(path)
	require.NoError(t, err)

	grown := validVTT + "\n00:00:10.000 --> 00:00:12.000\nlater\n"
	second := `{"complete":true,"tracks":[` +
		`{"language":"eng","title":"Signs"},` +
		`{"language":"por","title":"","vtt":` + strconvQuote(grown) + `}` +
		`]}`
	require.Equal(t, http.StatusCreated, postSubtitles(t, e, "r5", second).Code)

	got, err := store.Get(t.Context(), "r5")
	require.NoError(t, err)
	require.Equal(t, []room.TrackInfo{
		{Index: 0, Language: "eng", Title: "Signs", Codec: "webvtt", Digest: subtitleDigest(validVTT)},
		{Index: 1, Language: "por", Codec: "webvtt", Digest: subtitleDigest(grown)},
	}, got.SubtitleTracks)

	// The untouched track keeps both its bytes and the name viewers cached
	// them under, so nothing about it is refetched.
	after, err := os.Stat(path)
	require.NoError(t, err)
	require.Equal(t, before.ModTime(), after.ModTime())
	data, err := os.ReadFile(filepath.Join(cfg.DataDir, "rooms", "r5", "subs", "sub_1_por.vtt"))
	require.NoError(t, err)
	require.Equal(t, grown, string(data))
}

func TestStoreClientSubtitlesRefusesOmittedBytesForATrackItNeverHad(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "r6", FileName: "movie.mkv", Status: "uploading", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
	e := gin.New()
	RegisterSubtitlesRoute(e.Group("/api"), store, cfg, nil, nil)

	body := `{"tracks":[{"language":"eng","title":"Signs"}]}`
	require.Equal(t, http.StatusBadRequest, postSubtitles(t, e, "r6", body).Code)
}

func TestStoreClientSubtitlesLeavesUnchangedBytesAlone(t *testing.T) {
	// An older client posts every track every time; the digest is what keeps
	// that from rewriting files nobody changed.
	cfg := testCfg(t)
	store := newTestStore(t)
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "r7", FileName: "movie.mkv", Status: "uploading", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
	e := gin.New()
	RegisterSubtitlesRoute(e.Group("/api"), store, cfg, nil, nil)

	body := `{"complete":false,"tracks":[{"language":"eng","title":"Signs","vtt":` + strconvQuote(validVTT) + `}]}`
	require.Equal(t, http.StatusCreated, postSubtitles(t, e, "r7", body).Code)
	path := filepath.Join(cfg.DataDir, "rooms", "r7", "subs", "sub_0_eng.vtt")
	before, err := os.Stat(path)
	require.NoError(t, err)

	require.Equal(t, http.StatusCreated, postSubtitles(t, e, "r7", body).Code)
	after, err := os.Stat(path)
	require.NoError(t, err)
	require.Equal(t, before.ModTime(), after.ModTime())
}

func TestStoreClientSubtitlesRefusesACarryOverUnderADifferentName(t *testing.T) {
	// A sibling .srt finishing its read pushes every embedded track one slot
	// along. If the client miscounts, the index it left empty must not quietly
	// inherit the previous occupant's file.
	cfg := testCfg(t)
	store := newTestStore(t)
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "r8", FileName: "movie.mkv", Status: "uploading", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
	e := gin.New()
	RegisterSubtitlesRoute(e.Group("/api"), store, cfg, nil, nil)

	first := `{"complete":false,"tracks":[{"language":"spa","title":"Signs","vtt":` + strconvQuote(validVTT) + `}]}`
	require.Equal(t, http.StatusCreated, postSubtitles(t, e, "r8", first).Code)

	// Same slot, different track, no bytes: nothing on disk answers to this.
	shifted := `{"complete":false,"tracks":[{"language":"eng","title":"Forced"}]}`
	require.Equal(t, http.StatusBadRequest, postSubtitles(t, e, "r8", shifted).Code)
}

const validASS = "[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,hello\n"

func TestStoreClientSubtitlesWithASS(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "ra", FileName: "movie.mkv", Status: "uploading", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
	e := gin.New()
	RegisterSubtitlesRoute(e.Group("/api"), store, cfg, nil, nil)

	body := `{"tracks":[{"language":"eng","title":"Full","vtt":` + strconvQuote(validVTT) +
		`,"ass":` + strconvQuote(validASS) + `}]}`
	w := postSubtitles(t, e, "ra", body)
	require.Equal(t, http.StatusCreated, w.Code)

	got, err := store.Get(t.Context(), "ra")
	require.NoError(t, err)
	require.Len(t, got.SubtitleTracks, 1)
	require.Equal(t, "ass", got.SubtitleTracks[0].Codec)
	// One digest names both files together: it must differ from a VTT-only
	// track with the same VTT bytes.
	require.NotEqual(t, subtitleDigest(validVTT), got.SubtitleTracks[0].Digest)

	for name, want := range map[string]string{"sub_0_eng.vtt": validVTT, "sub_0_eng.ass": validASS} {
		data, err := os.ReadFile(filepath.Join(cfg.DataDir, "rooms", "ra", "subs", name))
		require.NoError(t, err)
		require.Equal(t, want, string(data))
	}
}

func TestStoreClientSubtitlesRejectsBadASS(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "rb", FileName: "movie.mkv", Status: "uploading", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
	e := gin.New()
	RegisterSubtitlesRoute(e.Group("/api"), store, cfg, nil, nil)

	body := `{"tracks":[{"language":"eng","title":"x","vtt":` + strconvQuote(validVTT) +
		`,"ass":` + strconvQuote("not an ass document") + `}]}`
	w := postSubtitles(t, e, "rb", body)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestStoreSubtitleFont(t *testing.T) {
	cfg := testCfg(t)
	store := newTestStore(t)
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "rf", FileName: "movie.mkv", Status: "uploading", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
	e := gin.New()
	RegisterSubtitlesRoute(e.Group("/api"), store, cfg, nil, nil)

	post := func(name, payload string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/rooms/rf/subtitles/fonts?name="+name, strings.NewReader(payload))
		req.Header.Set("Content-Type", "application/octet-stream")
		e.ServeHTTP(w, req)
		return w
	}

	w := post("OpenSans.ttf", "fontbytes")
	require.Equal(t, http.StatusOK, w.Code)

	got, err := store.Get(t.Context(), "rf")
	require.NoError(t, err)
	require.Len(t, got.SubtitleFonts, 1)
	require.Equal(t, "OpenSans.ttf", got.SubtitleFonts[0].Name)
	require.True(t, strings.HasPrefix(got.SubtitleFonts[0].File, "fonts/f_"))
	data, err := os.ReadFile(filepath.Join(cfg.DataDir, "rooms", "rf", "subs", got.SubtitleFonts[0].File))
	require.NoError(t, err)
	require.Equal(t, "fontbytes", string(data))

	// The same bytes land once: a duplicate post is acknowledged, not stored.
	w = post("OpenSans.ttf", "fontbytes")
	require.Equal(t, http.StatusOK, w.Code)
	got, err = store.Get(t.Context(), "rf")
	require.NoError(t, err)
	require.Len(t, got.SubtitleFonts, 1)

	// Extensions outside the whitelist are refused.
	w = post("evil.exe", "MZ")
	require.Equal(t, http.StatusBadRequest, w.Code)
}

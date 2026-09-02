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

	"github.com/giulianoo0/ss/internal/media"
	"github.com/giulianoo0/ss/internal/objectstore"
	"github.com/giulianoo0/ss/internal/room"
)

func clientMediaEngine(t *testing.T, store *room.Store, bucket *objectstore.Fake,
	hooks ClientMediaHooks) *gin.Engine {
	t.Helper()
	cfg := testCfg(t)
	cfg.MediaPublicURL = "https://media.example.test"
	e := gin.New()
	RegisterClientMediaRoutes(e.Group("/api"), store, cfg, bucket, hooks)
	return e
}

func addUploadingRoom(t *testing.T, store *room.Store, id string) {
	t.Helper()
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: id, FileName: "movie.mkv", Status: "uploading", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
}

func postJSON(t *testing.T, e *gin.Engine, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	e.ServeHTTP(w, req)
	return w
}

func claimRoom(t *testing.T, e *gin.Engine, roomID string) string {
	t.Helper()
	w := postJSON(t, e, "/api/rooms/"+roomID+"/client-media/claim", `{}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var resp clientClaimResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	require.NotEmpty(t, resp.Claim)
	return resp.Claim
}

func TestClientMediaClaimIsExclusive(t *testing.T) {
	store := newTestStore(t)
	addUploadingRoom(t, store, "r1")
	e := clientMediaEngine(t, store, objectstore.NewFake(), ClientMediaHooks{})

	claim := claimRoom(t, e, "r1")
	require.True(t, strings.HasPrefix(claim, "client:"))

	w := postJSON(t, e, "/api/rooms/r1/client-media/claim", `{}`)
	require.Equal(t, http.StatusConflict, w.Code)

	rel := httptest.NewRequest(http.MethodDelete, "/api/rooms/r1/client-media?claim="+claim, nil)
	relW := httptest.NewRecorder()
	e.ServeHTTP(relW, rel)
	require.Equal(t, http.StatusNoContent, relW.Code)
	claimRoom(t, e, "r1")
}

func TestClientMediaPresignSignsOnlyTheGrammar(t *testing.T) {
	store := newTestStore(t)
	addUploadingRoom(t, store, "r1")
	e := clientMediaEngine(t, store, objectstore.NewFake(), ClientMediaHooks{})
	claim := claimRoom(t, e, "r1")

	w := postJSON(t, e, "/api/rooms/r1/client-media/presign",
		`{"claim":"`+claim+`","objects":[{"name":"cinit_1.mp4","size":800},{"name":"cs_1_1.m4s","size":100000}]}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var resp struct {
		Objects []presignedObject `json:"objects"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	require.Len(t, resp.Objects, 2)
	require.Contains(t, resp.Objects[0].URL, "rooms/r1/g0/hls/cinit_1.mp4")
	require.Equal(t, media.ClientInitContentType, resp.Objects[0].Headers["Content-Type"])
	require.Equal(t, media.ClientSegmentContentType, resp.Objects[1].Headers["Content-Type"])
	require.Equal(t, media.ClientObjectCacheControl, resp.Objects[1].Headers["Cache-Control"])

	for _, name := range []string{"../evil.m4s", "master.m3u8", "stream_0_000.m4s", "cs_1_1.m4s/x"} {
		w := postJSON(t, e, "/api/rooms/r1/client-media/presign",
			`{"claim":"`+claim+`","objects":[{"name":"`+name+`","size":10}]}`)
		require.Equal(t, http.StatusBadRequest, w.Code, name)
	}

	w = postJSON(t, e, "/api/rooms/r1/client-media/presign",
		`{"claim":"client:deadbeef","objects":[{"name":"cs_1_2.m4s","size":10}]}`)
	require.Equal(t, http.StatusForbidden, w.Code)
}

func TestClientMediaPresignEnforcesTheBudget(t *testing.T) {
	store := newTestStore(t)
	addUploadingRoom(t, store, "r1")
	e := clientMediaEngine(t, store, objectstore.NewFake(), ClientMediaHooks{})
	claim := claimRoom(t, e, "r1")

	w := postJSON(t, e, "/api/rooms/r1/client-media/presign",
		`{"claim":"`+claim+`","objects":[{"name":"cs_1_1.m4s","size":`+
			`268435455},{"name":"cs_1_2.m4s","size":268435455}]}`)
	require.Equal(t, http.StatusRequestEntityTooLarge, w.Code, w.Body.String())
}

func TestClientMediaPublishOnlyTrustsTheBucket(t *testing.T) {
	store := newTestStore(t)
	addUploadingRoom(t, store, "r1")
	bucket := objectstore.NewFake()
	ready := make(chan string, 1)
	e := clientMediaEngine(t, store, bucket, ClientMediaHooks{
		NotifyStatus: func(id, status string) {
			if status == "ready" {
				ready <- id
			}
		},
	})
	claim := claimRoom(t, e, "r1")

	require.NoError(t, bucket.Put(t.Context(), "rooms/r1/g0/hls/cinit_1.mp4",
		strings.NewReader("init"), 4, media.ClientInitContentType, media.ClientObjectCacheControl))
	require.NoError(t, bucket.Put(t.Context(), "rooms/r1/g0/hls/cs_1_1.m4s",
		strings.NewReader("seg1"), 4, media.ClientSegmentContentType, media.ClientObjectCacheControl))

	playlist := "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n" +
		"#EXT-X-MAP:URI=\"cinit_1.mp4\"\n" +
		"#EXTINF:4.0,\ncs_1_1.m4s\n" +
		"#EXTINF:4.0,\ncs_1_2.m4s\n"
	master := "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS=\"avc1.640028,mp4a.40.2\"\nclient_stream_1.m3u8\n"
	body := `{"claim":"` + claim + `","mediaGeneration":0,` +
		`"confirm":["cinit_1.mp4","cs_1_1.m4s","cs_1_2.m4s"],` +
		`"playlists":{"master.m3u8":` + strconvQuote(master) + `,"client_stream_1.m3u8":` + strconvQuote(playlist) + `},` +
		`"audioTracks":[{"language":"jpn","title":"Japanese"}],` +
		`"chapters":[{"startMs":0,"endMs":4000,"title":"Abertura"}],` +
		`"progress":{"receivedBytes":8,"sourceBytes":16}}`
	w := postJSON(t, e, "/api/rooms/r1/client-media/publish", body)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var resp struct {
		Confirmed []string `json:"confirmed"`
		Ready     bool     `json:"ready"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	require.ElementsMatch(t, []string{"cinit_1.mp4", "cs_1_1.m4s"}, resp.Confirmed)
	require.True(t, resp.Ready)

	stored, err := store.Playlist(t.Context(), "r1", "client_stream_1.m3u8")
	require.NoError(t, err)
	require.Contains(t, stored, "https://media.example.test/rooms/r1/g0/hls/cs_1_1.m4s")
	require.NotContains(t, stored, "cs_1_2.m4s")
	masterStored, err := store.Playlist(t.Context(), "r1", "master.m3u8")
	require.NoError(t, err)
	require.Contains(t, masterStored, "client_stream_1.m3u8")

	select {
	case id := <-ready:
		require.Equal(t, "r1", id)
	case <-time.After(time.Second):
		t.Fatal("ready notification never fired")
	}
	got, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, "ready", got.Status)
	require.Equal(t, []room.TrackInfo{{Index: 0, Language: "jpn", Title: "Japanese", Codec: "aac"}}, got.AudioTracks)
	require.Equal(t, []room.Chapter{{StartMs: 0, EndMs: 4000, Title: "Abertura"}}, got.Chapters)
	require.Equal(t, int64(8), got.Preparation.ReceivedBytes)
}

func TestClientMediaPublishRefusesAStrangeMaster(t *testing.T) {
	store := newTestStore(t)
	addUploadingRoom(t, store, "r1")
	e := clientMediaEngine(t, store, objectstore.NewFake(), ClientMediaHooks{})
	claim := claimRoom(t, e, "r1")

	master := "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://evil.example/playlist.m3u8\n"
	w := postJSON(t, e, "/api/rooms/r1/client-media/publish",
		`{"claim":"`+claim+`","playlists":{"master.m3u8":`+strconvQuote(master)+`}}`)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestClientMediaPublishRefusesASmuggledMediaPlaylistTag(t *testing.T) {
	store := newTestStore(t)
	addUploadingRoom(t, store, "r1")
	e := clientMediaEngine(t, store, objectstore.NewFake(), ClientMediaHooks{})
	claim := claimRoom(t, e, "r1")

	evil := "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"https://evil/k\"\n#EXTINF:4.0,\ncs_1_1.m4s\n"
	w := postJSON(t, e, "/api/rooms/r1/client-media/publish",
		`{"claim":"`+claim+`","playlists":{"client_stream_1.m3u8":`+strconvQuote(evil)+`}}`)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestClientMediaEarlyMasterIsNotFatal(t *testing.T) {
	store := newTestStore(t)
	addUploadingRoom(t, store, "r1")
	e := clientMediaEngine(t, store, objectstore.NewFake(), ClientMediaHooks{})
	claim := claimRoom(t, e, "r1")

	master := "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nclient_stream_1.m3u8\n"
	w := postJSON(t, e, "/api/rooms/r1/client-media/publish",
		`{"claim":"`+claim+`","confirm":[],"playlists":{"master.m3u8":`+strconvQuote(master)+`}}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	_, err := store.Playlist(t.Context(), "r1", "master.m3u8")
	require.Error(t, err)
}

func TestClientMediaCompleteWithoutPlayableMediaFails(t *testing.T) {
	store := newTestStore(t)
	addUploadingRoom(t, store, "r1")
	e := clientMediaEngine(t, store, objectstore.NewFake(), ClientMediaHooks{})
	claim := claimRoom(t, e, "r1")

	w := postJSON(t, e, "/api/rooms/r1/client-media/publish",
		`{"claim":"`+claim+`","complete":true}`)
	require.Equal(t, http.StatusConflict, w.Code)
	got, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, "uploading", got.Status)
	claimRoom(t, e, "r1")
}

func TestClientMediaPublishRejectsAStaleGeneration(t *testing.T) {
	store := newTestStore(t)
	addUploadingRoom(t, store, "r1")
	e := clientMediaEngine(t, store, objectstore.NewFake(), ClientMediaHooks{})
	claim := claimRoom(t, e, "r1")

	w := postJSON(t, e, "/api/rooms/r1/client-media/publish",
		`{"claim":"`+claim+`","mediaGeneration":7,"confirm":[]}`)
	require.Equal(t, http.StatusConflict, w.Code)
}

func TestClientMediaCompleteReleasesTheClaim(t *testing.T) {
	store := newTestStore(t)
	addUploadingRoom(t, store, "r1")
	bucket := objectstore.NewFake()
	e := clientMediaEngine(t, store, bucket, ClientMediaHooks{})
	claim := claimRoom(t, e, "r1")

	require.NoError(t, bucket.Put(t.Context(), "rooms/r1/g0/hls/cinit_1.mp4",
		strings.NewReader("i"), 1, media.ClientInitContentType, media.ClientObjectCacheControl))
	require.NoError(t, bucket.Put(t.Context(), "rooms/r1/g0/hls/cs_1_1.m4s",
		strings.NewReader("s"), 1, media.ClientSegmentContentType, media.ClientObjectCacheControl))
	playlist := "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MAP:URI=\"cinit_1.mp4\"\n#EXTINF:4.0,\ncs_1_1.m4s\n#EXT-X-ENDLIST\n"
	master := "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS=\"avc1.640028\"\nclient_stream_1.m3u8\n"
	w := postJSON(t, e, "/api/rooms/r1/client-media/publish",
		`{"claim":"`+claim+`","confirm":["cinit_1.mp4","cs_1_1.m4s"],`+
			`"playlists":{"master.m3u8":`+strconvQuote(master)+`,"client_stream_1.m3u8":`+strconvQuote(playlist)+`},"complete":true}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	got, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, "ready", got.Status)
	held, err := store.UploadID(t.Context(), "r1")
	require.NoError(t, err)
	require.Empty(t, held)
}

func TestClientMediaTimelineFollowsTheMaster(t *testing.T) {
	store := newTestStore(t)
	addUploadingRoom(t, store, "r1")
	bucket := objectstore.NewFake()
	updated := make(chan string, 4)
	e := clientMediaEngine(t, store, bucket, ClientMediaHooks{
		NotifyRoomUpdated: func(id string) { updated <- id },
	})
	claim := claimRoom(t, e, "r1")

	require.NoError(t, bucket.Put(t.Context(), "rooms/r1/g0/hls/r1_cinit_1.mp4",
		strings.NewReader("init"), 4, media.ClientInitContentType, media.ClientObjectCacheControl))
	require.NoError(t, bucket.Put(t.Context(), "rooms/r1/g0/hls/r1_cs_1_1.m4s",
		strings.NewReader("seg1"), 4, media.ClientSegmentContentType, media.ClientObjectCacheControl))
	playlist := "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n" +
		"#EXT-X-MAP:URI=\"r1_cinit_1.mp4\"\n#EXTINF:4.0,\nr1_cs_1_1.m4s\n"
	master := "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS=\"avc1.640028,mp4a.40.2\"\nr1_client_stream_1.m3u8\n"

	early := `{"claim":"` + claim + `","mediaGeneration":0,` +
		`"playlists":{"master.m3u8":` + strconvQuote(master) + `,"r1_client_stream_1.m3u8":` + strconvQuote(playlist) + `},` +
		`"timeline":{"durationMs":1440000,"offsetMs":1080000}}`
	w := postJSON(t, e, "/api/rooms/r1/client-media/publish", early)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	got, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, int64(1440000), got.DurationMs)
	require.Zero(t, got.MediaOffsetMs)
	baseVersion := got.MediaVersion

	confirmed := `{"claim":"` + claim + `","mediaGeneration":0,` +
		`"confirm":["r1_cinit_1.mp4","r1_cs_1_1.m4s"],` +
		`"playlists":{"master.m3u8":` + strconvQuote(master) + `,"r1_client_stream_1.m3u8":` + strconvQuote(playlist) + `},` +
		`"timeline":{"durationMs":1440000,"offsetMs":1080000}}`
	w = postJSON(t, e, "/api/rooms/r1/client-media/publish", confirmed)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	got, err = store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, int64(1080000), got.MediaOffsetMs)
	require.Equal(t, baseVersion+1, got.MediaVersion)
	select {
	case id := <-updated:
		require.Equal(t, "r1", id)
	case <-time.After(time.Second):
		t.Fatal("room update notification never fired")
	}

	w = postJSON(t, e, "/api/rooms/r1/client-media/publish", confirmed)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	got, err = store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, baseVersion+1, got.MediaVersion)

	bad := `{"claim":"` + claim + `","mediaGeneration":0,"timeline":{"durationMs":-1,"offsetMs":0}}`
	w = postJSON(t, e, "/api/rooms/r1/client-media/publish", bad)
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
}

func TestClientMediaReadyWaitsForTheMaster(t *testing.T) {
	store := newTestStore(t)
	addUploadingRoom(t, store, "r1")
	bucket := objectstore.NewFake()
	e := clientMediaEngine(t, store, bucket, ClientMediaHooks{})
	claim := claimRoom(t, e, "r1")

	require.NoError(t, bucket.Put(t.Context(), "rooms/r1/g0/hls/cinit_1.mp4",
		strings.NewReader("i"), 1, media.ClientInitContentType, media.ClientObjectCacheControl))
	require.NoError(t, bucket.Put(t.Context(), "rooms/r1/g0/hls/cs_1_1.m4s",
		strings.NewReader("s"), 1, media.ClientSegmentContentType, media.ClientObjectCacheControl))
	video := "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MAP:URI=\"cinit_1.mp4\"\n#EXTINF:4.0,\ncs_1_1.m4s\n"
	master := "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"jpn\",URI=\"client_stream_2.m3u8\"\n" +
		"#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS=\"avc1.640028\",AUDIO=\"a\"\nclient_stream_1.m3u8\n"
	w := postJSON(t, e, "/api/rooms/r1/client-media/publish",
		`{"claim":"`+claim+`","confirm":["cinit_1.mp4","cs_1_1.m4s"],`+
			`"playlists":{"master.m3u8":`+strconvQuote(master)+`,"client_stream_1.m3u8":`+strconvQuote(video)+`}}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	got, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.NotEqual(t, "ready", got.Status)

	require.NoError(t, bucket.Put(t.Context(), "rooms/r1/g0/hls/cinit_2.mp4",
		strings.NewReader("i"), 1, media.ClientInitContentType, media.ClientObjectCacheControl))
	require.NoError(t, bucket.Put(t.Context(), "rooms/r1/g0/hls/cs_2_1.m4s",
		strings.NewReader("s"), 1, media.ClientSegmentContentType, media.ClientObjectCacheControl))
	audio := "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MAP:URI=\"cinit_2.mp4\"\n#EXTINF:4.0,\ncs_2_1.m4s\n"
	w = postJSON(t, e, "/api/rooms/r1/client-media/publish",
		`{"claim":"`+claim+`","confirm":["cinit_2.mp4","cs_2_1.m4s"],`+
			`"playlists":{"master.m3u8":`+strconvQuote(master)+`,"client_stream_1.m3u8":`+strconvQuote(video)+`,"client_stream_2.m3u8":`+strconvQuote(audio)+`}}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	got, err = store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, "ready", got.Status)
}

func TestClientMediaPublishKeepsARegionMap(t *testing.T) {
	store := newTestStore(t)
	addUploadingRoom(t, store, "r1")
	bucket := objectstore.NewFake()
	updated := make(chan string, 8)
	e := clientMediaEngine(t, store, bucket, ClientMediaHooks{
		NotifyRoomUpdated: func(id string) { updated <- id },
	})
	claim := claimRoom(t, e, "r1")
	for _, key := range []string{"r1_cinit_1.mp4", "r1_cs_1_1.m4s"} {
		require.NoError(t, bucket.Put(t.Context(), "rooms/r1/g0/hls/"+key,
			strings.NewReader("data"), 4, media.ClientSegmentContentType, media.ClientObjectCacheControl))
	}
	playlist := "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n" +
		"#EXT-X-MAP:URI=\"r1_cinit_1.mp4\"\n#EXTINF:4.0,\nr1_cs_1_1.m4s\n"
	master := "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS=\"avc1.640028,mp4a.40.2\"\nr1_client_stream_1.m3u8\n"

	body := `{"claim":"` + claim + `","mediaGeneration":0,` +
		`"confirm":["r1_cinit_1.mp4","r1_cs_1_1.m4s"],` +
		`"playlists":{"master.m3u8":` + strconvQuote(master) + `,"r1_master.m3u8":` + strconvQuote(master) + `,"r1_client_stream_1.m3u8":` + strconvQuote(playlist) + `},` +
		`"timeline":{"durationMs":1440000,"offsetMs":1080000,"regions":[{"n":0,"startMs":0,"producedMs":8000,"growing":false},{"n":1,"startMs":1080000,"producedMs":4000,"growing":true}]}}`
	w := postJSON(t, e, "/api/rooms/r1/client-media/publish", body)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	got, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, []room.MediaRegion{{N: 1, StartMs: 1080000, ProducedMs: 4000, Growing: true}}, got.MediaRegions)
	version := got.MediaVersion
	has, err := store.HasPlaylist(t.Context(), "r1", "r1_master.m3u8")
	require.NoError(t, err)
	require.True(t, has, "the region's own master is stored")

	grown := strings.Replace(body, `"producedMs":4000`, `"producedMs":8000`, 1)
	w = postJSON(t, e, "/api/rooms/r1/client-media/publish", grown)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	got, err = store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, int64(8000), got.MediaRegions[0].ProducedMs)
	require.Equal(t, version, got.MediaVersion)

	dup := strings.Replace(body, `{"n":0,"startMs":0`, `{"n":1,"startMs":0`, 1)
	w = postJSON(t, e, "/api/rooms/r1/client-media/publish", dup)
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
}

func TestClientMediaPublishCarriesWhatMoved(t *testing.T) {
	store := newTestStore(t)
	addUploadingRoom(t, store, "r1")
	bucket := objectstore.NewFake()
	snapshots := make(chan room.MediaSnapshot, 4)
	bare := make(chan string, 4)
	e := clientMediaEngine(t, store, bucket, ClientMediaHooks{
		NotifyRoomUpdated: func(id string) { bare <- id },
		NotifyRoomMedia:   func(_ string, media room.MediaSnapshot) { snapshots <- media },
	})
	claim := claimRoom(t, e, "r1")
	for _, key := range []string{"r1_cinit_1.mp4", "r1_cs_1_1.m4s"} {
		require.NoError(t, bucket.Put(t.Context(), "rooms/r1/g0/hls/"+key,
			strings.NewReader("data"), 4, media.ClientSegmentContentType, media.ClientObjectCacheControl))
	}
	playlist := "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n" +
		"#EXT-X-MAP:URI=\"r1_cinit_1.mp4\"\n#EXTINF:4.0,\nr1_cs_1_1.m4s\n"
	master := "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS=\"avc1.640028,mp4a.40.2\"\nr1_client_stream_1.m3u8\n"
	body := `{"claim":"` + claim + `","mediaGeneration":0,` +
		`"confirm":["r1_cinit_1.mp4","r1_cs_1_1.m4s"],` +
		`"playlists":{"master.m3u8":` + strconvQuote(master) + `,"r1_master.m3u8":` + strconvQuote(master) + `,"r1_client_stream_1.m3u8":` + strconvQuote(playlist) + `},` +
		`"timeline":{"durationMs":1440000,"offsetMs":1080000,"regions":[{"n":1,"startMs":1080000,"producedMs":4000,"growing":true}]}}`
	w := postJSON(t, e, "/api/rooms/r1/client-media/publish", body)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	select {
	case snap := <-snapshots:
		require.Equal(t, int64(1080000), snap.MediaOffsetMs)
		require.Equal(t, []room.MediaRegion{{N: 1, StartMs: 1080000, ProducedMs: 4000, Growing: true}}, snap.MediaRegions)
		require.Positive(t, snap.MediaVersion)
	case <-time.After(time.Second):
		t.Fatal("no media snapshot")
	}
	require.Empty(t, snapshots)
	require.Empty(t, bare)
}

func TestClientMediaCompleteRetryFindsReceipt(t *testing.T) {
	store := newTestStore(t)
	addUploadingRoom(t, store, "r1")
	bucket := objectstore.NewFake()
	e := clientMediaEngine(t, store, bucket, ClientMediaHooks{})
	claim := claimRoom(t, e, "r1")

	require.NoError(t, bucket.Put(t.Context(), media.HLSObjectKey("r1", 0, "cinit_1.mp4"), strings.NewReader("x"), 1, "video/mp4", ""))
	require.NoError(t, bucket.Put(t.Context(), media.HLSObjectKey("r1", 0, "cs_1_1.m4s"), strings.NewReader("x"), 1, "video/iso.segment", ""))
	variant := "#EXTM3U\n#EXT-X-MAP:URI=\"cinit_1.mp4\"\n#EXTINF:4.0,\ncs_1_1.m4s\n"
	master := "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nclient_stream_1.m3u8\n"
	w := postJSON(t, e, "/api/rooms/r1/client-media/publish",
		`{"claim":"`+claim+`","runId":"run1","seq":1,"confirm":["cinit_1.mp4","cs_1_1.m4s"],"playlists":{"client_stream_1.m3u8":`+strconvQuote(variant)+`,"master.m3u8":`+strconvQuote(master)+`},"complete":true}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	w = postJSON(t, e, "/api/rooms/r1/client-media/publish",
		`{"claim":"`+claim+`","runId":"run1","seq":2,"complete":true}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var resp struct {
		Ready bool `json:"ready"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	require.True(t, resp.Ready)
}

func TestClientMediaLateMetadataEndpoint(t *testing.T) {
	store := newTestStore(t)
	addUploadingRoom(t, store, "r1")
	e := clientMediaEngine(t, store, objectstore.NewFake(), ClientMediaHooks{})

	w := postJSON(t, e, "/api/rooms/r1/client-media/claim", `{}`)
	require.Equal(t, http.StatusOK, w.Code)
	var claimResp clientClaimResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &claimResp))
	require.NotEmpty(t, claimResp.MetadataToken)

	require.NoError(t, store.ReleaseUpload(t.Context(), "r1", claimResp.Claim))
	w = postJSON(t, e, "/api/rooms/r1/client-media/metadata",
		`{"token":"`+claimResp.MetadataToken+`","mediaGeneration":0,"chapters":[{"startMs":0,"endMs":90000,"title":"Opening"}]}`)
	require.Equal(t, http.StatusNoContent, w.Code, w.Body.String())
	got, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Len(t, got.Chapters, 1)

	w = postJSON(t, e, "/api/rooms/r1/client-media/metadata",
		`{"token":"meta:wrong","chapters":[{"startMs":0,"endMs":1000,"title":"x"}]}`)
	require.Equal(t, http.StatusForbidden, w.Code)
	_, _, err = store.SwapSource(t.Context(), "r1", room.SourceUpload, "other.mkv", "uploading", time.Now())
	require.NoError(t, err)
	w = postJSON(t, e, "/api/rooms/r1/client-media/metadata",
		`{"token":"`+claimResp.MetadataToken+`","chapters":[{"startMs":0,"endMs":1000,"title":"x"}]}`)
	require.Equal(t, http.StatusForbidden, w.Code)
}

func TestClientMediaPublishStaleSeqDoesNotRegress(t *testing.T) {
	store := newTestStore(t)
	addUploadingRoom(t, store, "r1")
	bucket := objectstore.NewFake()
	e := clientMediaEngine(t, store, bucket, ClientMediaHooks{})
	claim := claimRoom(t, e, "r1")

	require.NoError(t, bucket.Put(t.Context(), media.HLSObjectKey("r1", 0, "cinit_1.mp4"), strings.NewReader("x"), 1, "video/mp4", ""))
	require.NoError(t, bucket.Put(t.Context(), media.HLSObjectKey("r1", 0, "cs_1_1.m4s"), strings.NewReader("x"), 1, "video/iso.segment", ""))
	require.NoError(t, bucket.Put(t.Context(), media.HLSObjectKey("r1", 0, "cs_1_2.m4s"), strings.NewReader("x"), 1, "video/iso.segment", ""))
	long := "#EXTM3U\n#EXT-X-MAP:URI=\"cinit_1.mp4\"\n#EXTINF:4.0,\ncs_1_1.m4s\n#EXTINF:4.0,\ncs_1_2.m4s\n"
	short := "#EXTM3U\n#EXT-X-MAP:URI=\"cinit_1.mp4\"\n#EXTINF:4.0,\ncs_1_1.m4s\n"

	w := postJSON(t, e, "/api/rooms/r1/client-media/publish",
		`{"claim":"`+claim+`","runId":"run1","seq":2,"confirm":["cinit_1.mp4","cs_1_1.m4s","cs_1_2.m4s"],"playlists":{"client_stream_1.m3u8":`+strconvQuote(long)+`}}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	w = postJSON(t, e, "/api/rooms/r1/client-media/publish",
		`{"claim":"`+claim+`","runId":"run1","seq":1,"confirm":["cs_1_1.m4s"],"playlists":{"client_stream_1.m3u8":`+strconvQuote(short)+`}}`)
	require.Equal(t, http.StatusConflict, w.Code, w.Body.String())
	body, err := store.Playlist(t.Context(), "r1", "client_stream_1.m3u8")
	require.NoError(t, err)
	require.Contains(t, body, "cs_1_2.m4s")
}

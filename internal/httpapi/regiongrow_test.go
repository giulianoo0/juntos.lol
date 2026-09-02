package httpapi

import (
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/media"
	"github.com/giulianoo0/ss/internal/objectstore"
)

func TestRegionProducedMsKeepsGrowing(t *testing.T) {
	store := newTestStore(t)
	addUploadingRoom(t, store, "r1")
	bucket := objectstore.NewFake()
	e := clientMediaEngine(t, store, bucket, ClientMediaHooks{})
	claim := claimRoom(t, e, "r1")

	require.NoError(t, bucket.Put(t.Context(), media.HLSObjectKey("r1", 0, "r2_cinit_1.mp4"), strings.NewReader("x"), 1, "video/mp4", ""))
	require.NoError(t, bucket.Put(t.Context(), media.HLSObjectKey("r1", 0, "r2_cs_1_1.m4s"), strings.NewReader("x"), 1, "video/iso.segment", ""))
	require.NoError(t, bucket.Put(t.Context(), media.HLSObjectKey("r1", 0, "r2_cs_1_2.m4s"), strings.NewReader("x"), 1, "video/iso.segment", ""))
	variant := "#EXTM3U\n#EXT-X-MAP:URI=\"r2_cinit_1.mp4\"\n#EXTINF:4.0,\nr2_cs_1_1.m4s\n#EXTINF:4.0,\nr2_cs_1_2.m4s\n"
	master := "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nr2_client_stream_1.m3u8\n"

	w := postJSON(t, e, "/api/rooms/r1/client-media/publish",
		`{"claim":"`+claim+`","runId":"run1","seq":1,"confirm":["r2_cinit_1.mp4","r2_cs_1_1.m4s","r2_cs_1_2.m4s"],`+
			`"playlists":{"r2_client_stream_1.m3u8":`+strconvQuote(variant)+`,"master.m3u8":`+strconvQuote(master)+`,"r2_master.m3u8":`+strconvQuote(master)+`},`+
			`"timeline":{"durationMs":1440000,"offsetMs":0,"regions":[{"n":2,"startMs":0,"producedMs":8000,"growing":true}]}}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	got, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Len(t, got.MediaRegions, 1)
	require.EqualValues(t, 8000, got.MediaRegions[0].ProducedMs)

	w = postJSON(t, e, "/api/rooms/r1/client-media/publish",
		`{"claim":"`+claim+`","runId":"run1","seq":2,"confirm":[],`+
			`"playlists":{},`+
			`"timeline":{"durationMs":1440000,"offsetMs":0,"regions":[{"n":2,"startMs":0,"producedMs":30000,"growing":true}]}}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	got, err = store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Len(t, got.MediaRegions, 1)
	require.EqualValues(t, 30000, got.MediaRegions[0].ProducedMs)
}

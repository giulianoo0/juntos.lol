package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

const livePlaylist = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-MAP:URI=\"cinit_1.mp4\"\n" +
	"#EXTINF:4.0,\ncs_1_1.m4s\n#EXTINF:4.0,\ncs_1_2.m4s\n"

func TestPlaylistReach(t *testing.T) {
	last, ended := playlistReach(livePlaylist)
	require.Equal(t, int64(1), last)
	require.False(t, ended)
	last, ended = playlistReach("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:5\n#EXTINF:4.0,\na.m4s\n#EXT-X-ENDLIST\n")
	require.Equal(t, int64(5), last)
	require.True(t, ended)
	last, _ = playlistReach(testPlaylist)
	require.Equal(t, int64(-1), last)
}

func TestRequestedSequence(t *testing.T) {
	msn, ok := requestedSequence("_HLS_msn=7&_HLS_part=0")
	require.True(t, ok)
	require.Equal(t, int64(7), msn)
	_, ok = requestedSequence("g=1")
	require.False(t, ok)
	_, ok = requestedSequence("_HLS_msn=abc")
	require.False(t, ok)
}

func TestWithBlockingReloadOnlyOnLiveMediaPlaylists(t *testing.T) {
	live := withBlockingReload(livePlaylist)
	require.Contains(t, live, "#EXT-X-TARGETDURATION:4\n#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES\n#EXT-X-MAP")
	require.Equal(t, livePlaylist+"#EXT-X-ENDLIST\n", withBlockingReload(livePlaylist+"#EXT-X-ENDLIST\n"))
	require.Equal(t, testPlaylist, withBlockingReload(testPlaylist))
}

func TestServePlaylistHoldsForTheSequenceItDoesNotHaveYet(t *testing.T) {
	store := newTestStore(t)
	addMediaTestRoom(t, store, "r1")
	require.NoError(t, store.SetPlaylists(t.Context(), "r1", map[string]string{"client_stream_1.m3u8": livePlaylist}))
	waiter := newPlaylistWaiter()
	e := gin.New()
	RegisterMediaRoutes(e, store, waiter)

	w := httptest.NewRecorder()
	e.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/media/r1/hls/client_stream_1.m3u8?_HLS_msn=1", nil))
	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Body.String(), "CAN-BLOCK-RELOAD=YES")

	var wg sync.WaitGroup
	wg.Add(1)
	held := httptest.NewRecorder()
	started := time.Now()
	go func() {
		defer wg.Done()
		e.ServeHTTP(held, httptest.NewRequest(http.MethodGet, "/media/r1/hls/client_stream_1.m3u8?_HLS_msn=2", nil))
	}()
	time.Sleep(150 * time.Millisecond)
	grown := livePlaylist + "#EXTINF:4.0,\ncs_1_3.m4s\n"
	require.NoError(t, store.SetPlaylists(t.Context(), "r1", map[string]string{"client_stream_1.m3u8": grown}))
	waiter.Notify("r1")
	wg.Wait()
	require.Equal(t, http.StatusOK, held.Code)
	require.Contains(t, held.Body.String(), "cs_1_3.m4s")
	require.GreaterOrEqual(t, time.Since(started), 150*time.Millisecond)
	require.Less(t, time.Since(started), blockingReloadMax)
}

func TestServePlaylistDoesNotHoldAnEndedPlaylist(t *testing.T) {
	store := newTestStore(t)
	addMediaTestRoom(t, store, "r1")
	ended := livePlaylist + "#EXT-X-ENDLIST\n"
	require.NoError(t, store.SetPlaylists(t.Context(), "r1", map[string]string{"client_stream_1.m3u8": ended}))
	e := gin.New()
	RegisterMediaRoutes(e, store, newPlaylistWaiter())

	w := httptest.NewRecorder()
	started := time.Now()
	e.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/media/r1/hls/client_stream_1.m3u8?_HLS_msn=99", nil))
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, ended, w.Body.String())
	require.Less(t, time.Since(started), 100*time.Millisecond)
}

func TestPublishWakesPlaylistWaiters(t *testing.T) {
	waiter := newPlaylistWaiter()
	done := make(chan bool, 1)
	ch := waiter.channel("r1")
	go func() { done <- waiter.wait(t.Context(), ch, time.Now().Add(5*time.Second)) }()
	time.Sleep(20 * time.Millisecond)
	waiter.Notify("r1")
	select {
	case woke := <-done:
		require.True(t, woke)
	case <-time.After(time.Second):
		t.Fatal("waiter never woke")
	}
	waiter.Notify("nobody")
	var none *playlistWaiter
	none.Notify("r1")
	require.False(t, none.wait(t.Context(), none.channel("r1"), time.Now().Add(time.Millisecond)))
}

func TestServeBundleCarriesTheMasterAndItsPlaylists(t *testing.T) {
	store := newTestStore(t)
	addMediaTestRoom(t, store, "r1")
	master := "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",NAME=\"por\",URI=\"r2_client_stream_2.m3u8\"\n" +
		"#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO=\"audio\"\nr2_client_stream_1.m3u8\n"
	require.NoError(t, store.SetPlaylists(t.Context(), "r1", map[string]string{
		"r2_master.m3u8":          master,
		"r2_client_stream_1.m3u8": livePlaylist,
	}))
	require.Equal(t, []string{"r2_client_stream_2.m3u8", "r2_client_stream_1.m3u8"}, masterPlaylistNames(master))

	w := httptest.NewRecorder()
	mediaEngine(store).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/media/r1/bundle?master=r2_master.m3u8", nil))
	require.Equal(t, http.StatusOK, w.Code)
	var got struct {
		Master    string            `json:"master"`
		Playlists map[string]string `json:"playlists"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	require.Equal(t, master, got.Master)
	require.Len(t, got.Playlists, 1)
	require.Contains(t, got.Playlists["r2_client_stream_1.m3u8"], "CAN-BLOCK-RELOAD=YES")
	require.Contains(t, got.Playlists["r2_client_stream_1.m3u8"], "cs_1_2.m4s")

	w = httptest.NewRecorder()
	mediaEngine(store).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/media/r1/bundle?master=nope.m3u8", nil))
	require.Equal(t, http.StatusNotFound, w.Code)
	w = httptest.NewRecorder()
	mediaEngine(store).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/media/r1/bundle?master=../x.m3u8", nil))
	require.Equal(t, http.StatusNotFound, w.Code)
}

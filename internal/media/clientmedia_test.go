package media

import (
	"strings"
	"testing"
)

func TestSanitizeClientMediaPlaylistRejectsSmuggledURIs(t *testing.T) {
	good := "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n" +
		"#EXT-X-MAP:URI=\"cinit_1.mp4\"\n#EXTINF:4.0,\ncs_1_1.m4s\n#EXT-X-ENDLIST\n"
	if !SanitizeClientMediaPlaylist([]byte(good)) {
		t.Fatal("a normal client media playlist was rejected")
	}

	for _, body := range []string{
		"#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"https://evil/key\"\n#EXTINF:4.0,\ncs_1_1.m4s\n",
		"#EXTM3U\n#EXT-X-DATERANGE:ID=\"x\",X-ASSET-URI=\"https://evil/a\"\n#EXTINF:4.0,\ncs_1_1.m4s\n",
		"#EXTM3U\n#EXT-X-SESSION-DATA:DATA-ID=\"x\",URI=\"https://evil/s\"\n",
		"#EXTM3U\n#EXT-X-MAP:URI=\"cinit_1.mp4\",URI=\"https://evil/e\"\n#EXTINF:4.0,\ncs_1_1.m4s\n",
	} {
		if SanitizeClientMediaPlaylist([]byte(body)) {
			t.Fatalf("smuggled URI accepted: %q", body)
		}
	}
}

func TestJudgeClientMaster(t *testing.T) {
	known := map[string]bool{"client_stream_1.m3u8": true}
	available := func(name string) bool { return known[name] }

	master := "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nclient_stream_1.m3u8\n"
	if got := JudgeClientMaster([]byte(master), available); got != ClientMasterReady {
		t.Fatalf("ready master judged %d", got)
	}

	early := "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nclient_stream_2.m3u8\n"
	if got := JudgeClientMaster([]byte(early), available); got != ClientMasterEarly {
		t.Fatalf("early master judged %d", got)
	}

	for _, body := range []string{
		"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://evil/e.m3u8\n",
		"#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI=\"client_stream_1.m3u8\",URI=\"https://evil/e.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nclient_stream_1.m3u8\n",
		"#EXTM3U\n#EXT-X-KEY:URI=\"https://evil/k\"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nclient_stream_1.m3u8\n",
		"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n../stream_0.m3u8\n",
		"#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,uri=\"https://evil/e.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nclient_stream_1.m3u8\n",
		"#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI=https://evil/e.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1\nclient_stream_1.m3u8\n",
	} {
		if got := JudgeClientMaster([]byte(body), available); got != ClientMasterInvalid {
			t.Fatalf("invalid master judged %d: %q", got, body)
		}
	}

	known["client_stream_2.m3u8"] = true
	grouped := "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",URI=\"client_stream_2.m3u8\"\n" +
		"#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO=\"a\"\nclient_stream_1.m3u8\n"
	if got := JudgeClientMaster([]byte(grouped), available); got != ClientMasterReady {
		t.Fatalf("valid audio-group master judged %d", got)
	}
}

func TestClientNameGrammarsAcceptRegions(t *testing.T) {
	for _, name := range []string{"cinit_0.mp4", "r1_cinit_0.mp4", "r12_cs_0_33.m4s"} {
		if _, ok := ClientObjectContentType(name); !ok {
			t.Errorf("object %q refused", name)
		}
	}
	for _, name := range []string{"r_cinit_0.mp4", "r1234567_cs_0_1.m4s", "r1_master.m3u8", "x1_cs_0_1.m4s"} {
		if _, ok := ClientObjectContentType(name); ok {
			t.Errorf("object %q accepted", name)
		}
	}
	for _, name := range []string{"master.m3u8", "r1_master.m3u8", "client_stream_0.m3u8", "r3_client_stream_0.m3u8"} {
		if !ValidClientPlaylistName(name) {
			t.Errorf("playlist %q refused", name)
		}
	}
	for _, name := range []string{"master.m3u8.bak", "x1_master.m3u8", "r_master.m3u8"} {
		if ValidClientPlaylistName(name) {
			t.Errorf("playlist %q accepted", name)
		}
	}
}

func TestRenderClientPlaylistKeepsTheEndMarkerOfASealedRegion(t *testing.T) {
	body := []byte("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MAP:URI=\"r1_cinit_1.mp4\"\n" +
		"#EXTINF:4.0,\nr1_cs_1_1.m4s\n#EXT-X-ENDLIST\n")
	published := map[string]struct{}{"r1_cinit_1.mp4": {}, "r1_cs_1_1.m4s": {}}

	rendered, ok := RenderClientPlaylist("https://media.example.com", "r1", 0, body, published)
	if !ok {
		t.Fatal("a sealed playlist whose segments all landed was refused")
	}
	if !strings.HasSuffix(rendered, "#EXT-X-ENDLIST\n") {
		t.Fatalf("end marker lost: %q", rendered)
	}
	if !strings.Contains(rendered, "https://media.example.com/rooms/r1/g0/hls/r1_cs_1_1.m4s") {
		t.Fatalf("segment not rewritten onto the bucket: %q", rendered)
	}
}

func TestRenderClientPlaylistDropsTheEndMarkerWhenItHadToCut(t *testing.T) {
	body := []byte("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MAP:URI=\"r1_cinit_1.mp4\"\n" +
		"#EXTINF:4.0,\nr1_cs_1_1.m4s\n#EXTINF:4.0,\nr1_cs_1_2.m4s\n#EXT-X-ENDLIST\n")
	published := map[string]struct{}{"r1_cinit_1.mp4": {}, "r1_cs_1_1.m4s": {}}

	rendered, ok := RenderClientPlaylist("https://media.example.com", "r1", 0, body, published)
	if !ok {
		t.Fatal("the confirmed prefix should still render")
	}
	if strings.Contains(rendered, "#EXT-X-ENDLIST") {
		t.Fatalf("a cut playlist claimed to be finished: %q", rendered)
	}
}

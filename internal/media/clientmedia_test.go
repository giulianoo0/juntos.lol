package media

import "testing"

func TestSanitizeClientMediaPlaylistRejectsSmuggledURIs(t *testing.T) {
	good := "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n" +
		"#EXT-X-MAP:URI=\"cinit_1.mp4\"\n#EXTINF:4.0,\ncs_1_1.m4s\n#EXT-X-ENDLIST\n"
	if !SanitizeClientMediaPlaylist([]byte(good)) {
		t.Fatal("a normal client media playlist was rejected")
	}

	// Every one of these carries a fetch the server must never sign off on.
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

	// Sound and every variant available.
	master := "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nclient_stream_1.m3u8\n"
	if got := JudgeClientMaster([]byte(master), available); got != ClientMasterReady {
		t.Fatalf("ready master judged %d", got)
	}

	// Sound but the variant has not landed: early, not invalid — the state
	// every run starts in.
	early := "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nclient_stream_2.m3u8\n"
	if got := JudgeClientMaster([]byte(early), available); got != ClientMasterEarly {
		t.Fatalf("early master judged %d", got)
	}

	// A foreign origin, a duplicate URI, a disallowed tag, a bad name, and —
	// crucially — a lowercase or unquoted URI that a case-sensitive check
	// would have waved through, are each invalid.
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

	// A well-formed audio group naming a known local playlist is fine.
	known["client_stream_2.m3u8"] = true
	grouped := "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",URI=\"client_stream_2.m3u8\"\n" +
		"#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO=\"a\"\nclient_stream_1.m3u8\n"
	if got := JudgeClientMaster([]byte(grouped), available); got != ClientMasterReady {
		t.Fatalf("valid audio-group master judged %d", got)
	}
}

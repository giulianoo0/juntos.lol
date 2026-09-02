package media

import "testing"

const workerMaster = "#EXTM3U\n#EXT-X-VERSION:7\n" +
	"#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"audio_1\",LANGUAGE=\"jpn\",DEFAULT=YES,AUTOSELECT=YES,URI=\"r2_client_stream_1.m3u8\"\n" +
	"#EXT-X-STREAM-INF:BANDWIDTH=5273544,AUDIO=\"aud\"\nr2_client_stream_0.m3u8\n"

func TestWorkerSynthesizedMasterIsAccepted(t *testing.T) {
	if JudgeClientMaster([]byte(workerMaster), func(string) bool { return true }) == ClientMasterInvalid {
		t.Fatal("worker master judged invalid")
	}
}

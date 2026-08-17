package media

import (
	"strings"
	"testing"

	"github.com/giulianoo0/ss/internal/room"
	"github.com/stretchr/testify/require"
)

func TestBuildRemuxArgsMultiAudio(t *testing.T) {
	p := &ProbeResult{
		VideoCodec:    "h264",
		VideoCopyable: true,
		Audio: []room.TrackInfo{
			{Index: 0, Language: "eng", Codec: "aac"},
			{Index: 1, Language: "jpn", Codec: "ac3"},
		},
	}

	args := BuildRemuxArgs("/x/original.mkv", "/x/hls", p)
	joined := strings.Join(args, " ")
	require.Contains(t, joined, "-c:v copy")
	require.Contains(t, joined, "-map 0:v:0")
	require.Contains(t, joined, "-map 0:a:0")
	require.Contains(t, joined, "-map 0:a:1")
	require.Contains(t, joined, "-var_stream_map a:0,agroup:audio,default:yes,language:eng")
	require.Contains(t, joined, "a:1,agroup:audio,language:jpn")
	require.Contains(t, joined, "v:0,agroup:audio")
	require.Contains(t, joined, "-master_pl_name master.m3u8")
	require.Contains(t, joined, "-hls_segment_type fmp4")
	require.Contains(t, joined, "-c:a aac")
	require.Equal(t, "/x/hls/stream_%v.m3u8", args[len(args)-1])
}

func TestBuildRemuxArgsTranscodesUncopyableVideo(t *testing.T) {
	p := &ProbeResult{VideoCodec: "vp9", VideoCopyable: false}

	joined := strings.Join(BuildRemuxArgs("in.webm", "hls", p), " ")

	require.Contains(t, joined, "-c:v libx264 -preset veryfast -crf 23")
	require.NotContains(t, joined, "-c:v copy")
}

func TestBuildRemuxArgsOmitsUnsafeAudioLanguage(t *testing.T) {
	tests := []struct {
		name     string
		language string
		want     string
	}{
		{name: "ISO 639 code", language: "eng", want: "language:eng"},
		{name: "BCP 47 code", language: "pt-BR", want: "language:pt-BR"},
		{name: "space", language: "en us"},
		{name: "comma", language: "eng,default:no"},
		{name: "colon", language: "eng:name"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := &ProbeResult{VideoCopyable: true, Audio: []room.TrackInfo{{Index: 0, Language: tt.language}}}

			joined := strings.Join(BuildRemuxArgs("in.mkv", "hls", p), " ")

			if tt.want == "" {
				require.NotContains(t, joined, "language:")
			} else {
				require.Contains(t, joined, tt.want)
			}
		})
	}
}

func TestStderrTail(t *testing.T) {
	require.Equal(t, "short", stderrTail([]byte("short"), 2048))
	require.Equal(t, "cdef", stderrTail([]byte("abcdef"), 4))
}

package media

import (
	"os"
	"path/filepath"
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
	require.Contains(t, joined, "-master_pl_name final_master.m3u8")
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

func TestBuildProgressiveRemuxArgs(t *testing.T) {
	p := &ProbeResult{
		VideoCopyable: true,
		Audio:         []room.TrackInfo{{Index: 0, Language: "eng"}},
	}

	args := BuildProgressiveRemuxArgs("pipe:0", "/x/hls", p)
	joined := strings.Join(args, " ")
	require.Contains(t, joined, "-i pipe:0")
	require.NotContains(t, joined, "-re")
	require.Contains(t, joined, "-hls_time 2")
	require.NotContains(t, joined, "-force_key_frames")
	require.Contains(t, joined, "-hls_playlist_type event")
	require.NotContains(t, joined, "-hls_playlist_type vod")
	require.Contains(t, joined, "-var_stream_map a:0,agroup:audio,default:yes,language:eng")
	require.Contains(t, joined, "-master_pl_name master.m3u8")
	require.Contains(t, joined, "-hls_fmp4_init_filename preview_init_%v.mp4")
	require.Contains(t, joined, "/x/hls/preview_stream_%v_%06d.m4s")
	require.Equal(t, "/x/hls/preview_stream_%v.m3u8", args[len(args)-1])

	vod := strings.Join(BuildRemuxArgs("/x/partial", "/x/hls", p), " ")
	require.Contains(t, vod, "-hls_playlist_type vod")
	require.Contains(t, vod, "-hls_time 6")
	require.Contains(t, vod, "-master_pl_name final_master.m3u8")
	require.NotContains(t, vod, "-re")
	require.NotContains(t, vod, "event")
}

func TestBuildProgressiveRemuxArgsAlignsTranscodedKeyframes(t *testing.T) {
	p := &ProbeResult{VideoCodec: "av1", VideoCopyable: false}

	joined := strings.Join(BuildProgressiveRemuxArgs("pipe:0", "/x/hls", p), " ")

	require.Contains(t, joined, "-c:v libx264 -preset ultrafast -crf 23")
	require.NotContains(t, joined, "-preset veryfast")
	require.Contains(t, joined, `-force_key_frames expr:gte(t,n_forced*2)`)
	require.Contains(t, joined, "-hls_time 2")

	vod := strings.Join(BuildRemuxArgs("/x/original.mkv", "/x/hls", p), " ")
	require.Contains(t, vod, "-c:v libx264 -preset veryfast -crf 23")
	require.NotContains(t, vod, "-force_key_frames")
	require.Contains(t, vod, "-hls_time 6")
}

func TestStderrTail(t *testing.T) {
	require.Equal(t, "short", stderrTail([]byte("short"), 2048))
	require.Equal(t, "cdef", stderrTail([]byte("abcdef"), 4))
}

func TestFinalizeProgressiveOutputsKeepsPreviewPlayable(t *testing.T) {
	dir := t.TempDir()
	event := "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:2.000,\npreview_stream_0_000000.m4s\n"
	for name, content := range map[string]string{
		"master.m3u8":                     "x",
		"stream_0.m3u8":                   "x",
		"stream_0_000.m4s":                "x",
		"init_0.mp4":                      "x",
		"preview_stream_0.m3u8":           event,
		"preview_stream_0_000000.m4s":     "x",
		"preview_init_0.mp4":              "x",
		"preview_stream_0_000001.m4s.tmp": "x",
	} {
		require.NoError(t, os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644))
	}

	require.NoError(t, finalizeProgressiveOutputs(dir))
	// A viewer who joined during the preview still holds these playlists, so
	// segments and inits must survive the final publish.
	require.FileExists(t, filepath.Join(dir, "preview_stream_0_000000.m4s"))
	require.FileExists(t, filepath.Join(dir, "preview_init_0.mp4"))
	require.NoFileExists(t, filepath.Join(dir, "preview_stream_0_000001.m4s.tmp"))
	playlist, err := os.ReadFile(filepath.Join(dir, "preview_stream_0.m3u8"))
	require.NoError(t, err)
	require.Contains(t, string(playlist), "#EXT-X-ENDLIST\n")
	require.FileExists(t, filepath.Join(dir, "master.m3u8"))
	require.FileExists(t, filepath.Join(dir, "stream_0.m3u8"))

	// Finalizing again must not stack a second ENDLIST.
	require.NoError(t, finalizeProgressiveOutputs(dir))
	again, err := os.ReadFile(filepath.Join(dir, "preview_stream_0.m3u8"))
	require.NoError(t, err)
	require.Equal(t, 1, strings.Count(string(again), "#EXT-X-ENDLIST"))
}

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
	require.Contains(t, joined, "-c:v:0 copy")
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

	require.Contains(t, joined, "-c:v:0 libx264 -preset:v:0 veryfast -crf:v:0 23")
	require.NotContains(t, joined, "-c:v:0 copy")
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
	require.Contains(t, joined, "-hls_time 4")
	require.NotContains(t, joined, "-force_key_frames")
	require.Contains(t, joined, "-hls_playlist_type event")
	require.NotContains(t, joined, "-hls_playlist_type vod")
	require.Contains(t, joined, "-var_stream_map v:0,a:0")
	require.Contains(t, joined, "-master_pl_name master.m3u8")
	require.Contains(t, joined, "-hls_fmp4_init_filename preview_init_0.mp4")
	require.Contains(t, joined, "/x/hls/preview_stream_%v_%06d.m4s")
	require.Equal(t, "/x/hls/preview_stream_%v.m3u8", args[len(args)-1])

	// The final pass grows its playlist as it encodes. A vod playlist is only
	// written when ffmpeg finishes, so nothing it produces can be published
	// until the whole encode lands and the room stays frozen at whatever the
	// preview reached — for a source that arrived all at once, a few seconds.
	final := strings.Join(BuildRemuxArgs("/x/partial", "/x/hls", p), " ")
	require.Contains(t, final, "-hls_playlist_type event")
	require.NotContains(t, final, "-hls_playlist_type vod")
	require.Contains(t, final, "-hls_time 6")
	require.Contains(t, final, "-master_pl_name final_master.m3u8")
	require.NotContains(t, final, "-re")
}

func TestBuildProgressiveRemuxArgsCarriesEveryDub(t *testing.T) {
	p := &ProbeResult{
		VideoCopyable: true,
		Audio: []room.TrackInfo{
			{Index: 0, Language: "jpn"}, {Index: 1, Language: "eng"}, {Index: 2, Language: "ger"},
		},
	}

	preview := strings.Join(BuildProgressiveRemuxArgs("pipe:0", "/x/hls", p), " ")
	// Holding the dubs back until the final ladder means holding them back for
	// the length of the encode — tens of minutes on a feature. The preview
	// gives them their own group, so the switch is there as soon as the room is.
	require.Contains(t, preview, "-map 0:a:0")
	require.Contains(t, preview, "-map 0:a:1")
	require.Contains(t, preview, "-map 0:a:2")
	require.Contains(t, preview, "-var_stream_map a:0,agroup:audio,default:yes,language:jpn")
	require.Contains(t, preview, "a:1,agroup:audio,language:eng")
	require.Contains(t, preview, "a:2,agroup:audio,language:ger")

	// The dubs take the leading variant slots, so the video is no longer
	// variant 0. Asking the wrong playlist announces the room as ready while
	// the video is still empty.
	require.Contains(t, preview, "v:0,agroup:audio")
	require.Equal(t, "preview_stream_3.m3u8", previewVideoVariantPlaylist(p))

	// The preview stays one video rendition; only the final pass gets a ladder.
	require.NotContains(t, preview, "v:1")

	// The final pass still carries all of them.
	final := strings.Join(BuildRemuxArgs("/x/partial", "/x/hls", p), " ")
	require.Contains(t, final, "-map 0:a:1")
	require.Contains(t, final, "-map 0:a:2")
}

func TestBuildProgressiveRemuxArgsMuxesAudioIntoTheOnlyVariant(t *testing.T) {
	p := &ProbeResult{
		VideoCopyable: true,
		Audio:         []room.TrackInfo{{Index: 0, Language: "eng"}},
	}

	preview := strings.Join(BuildProgressiveRemuxArgs("pipe:0", "/x/hls", p), " ")

	// An audio group is a second segment stream, so it doubles what the preview
	// writes and uploads. It buys nothing here: the preview carries one video
	// rendition and one dub, so there is no switch for the group to survive.
	require.Contains(t, preview, "-var_stream_map v:0,a:0")
	require.NotContains(t, preview, "agroup")
	require.Equal(t, "preview_stream_0.m3u8", previewVideoVariantPlaylist(p))

	// The final ladder keeps its group: switching picture quality there must
	// not reopen the audio the viewer chose.
	final := strings.Join(BuildRemuxArgs("/x/original.mkv", "/x/hls", p), " ")
	require.Contains(t, final, "v:0,agroup:audio")
}

func TestBuildRemuxArgsNamesTheInitSegmentAVariantAtATime(t *testing.T) {
	// ffmpeg only expands %v in the init filename when the output carries more
	// than one variant. With a single one it writes a file called literally
	// "preview_init_%v.mp4", the playlist points EXT-X-MAP at that name, and
	// nothing decodes: the player fetches an init segment that is not there
	// and waits forever.
	single := &ProbeResult{VideoCopyable: true, Audio: []room.TrackInfo{{Index: 0}}}

	preview := strings.Join(BuildProgressiveRemuxArgs("pipe:0", "/x/hls", single), " ")

	require.Contains(t, preview, "-hls_fmp4_init_filename preview_init_0.mp4")
	require.NotContains(t, preview, "preview_init_%v.mp4")

	// A ladder with an audio group has several, so the placeholder is expanded
	// by ffmpeg and has to stay.
	ladder := &ProbeResult{VideoCopyable: true, VideoHeight: 1080, Audio: []room.TrackInfo{{Index: 0}}}
	final := strings.Join(BuildRemuxArgs("/x/original.mkv", "/x/hls", ladder), " ")
	require.Contains(t, final, "-hls_fmp4_init_filename init_%v.mp4")

	// A final pass can end up with one variant too: a source small enough for
	// no lower rung, with no audio to group.
	lone := &ProbeResult{VideoCopyable: true, VideoHeight: 360}
	loneFinal := strings.Join(BuildRemuxArgs("/x/original.mkv", "/x/hls", lone), " ")
	require.Contains(t, loneFinal, "-hls_fmp4_init_filename init_0.mp4")
}

func TestBuildProgressiveRemuxArgsMapsSilentSourcesAlone(t *testing.T) {
	p := &ProbeResult{VideoCopyable: true}

	preview := strings.Join(BuildProgressiveRemuxArgs("pipe:0", "/x/hls", p), " ")

	require.Contains(t, preview, "-var_stream_map v:0")
	require.NotContains(t, preview, "a:0")
	require.Equal(t, "preview_stream_0.m3u8", previewVideoVariantPlaylist(p))
}

func TestBuildProgressiveRemuxArgsAlignsTranscodedKeyframes(t *testing.T) {
	p := &ProbeResult{VideoCodec: "av1", VideoCopyable: false}

	joined := strings.Join(BuildProgressiveRemuxArgs("pipe:0", "/x/hls", p), " ")

	require.Contains(t, joined, "-c:v:0 libx264 -preset:v:0 ultrafast -crf:v:0 23")
	require.NotContains(t, joined, "-preset veryfast")
	// The forced keyframe cadence has to follow the segment length: a segment
	// cannot start anywhere but a keyframe, so a mismatch makes ffmpeg hold the
	// first playable segment until libx264's own much longer GOP closes.
	require.Contains(t, joined, `-force_key_frames expr:gte(t,n_forced*4)`)
	require.Contains(t, joined, "-hls_time 4")

	vod := strings.Join(BuildRemuxArgs("/x/original.mkv", "/x/hls", p), " ")
	require.Contains(t, vod, "-c:v:0 libx264 -preset:v:0 veryfast -crf:v:0 23")
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

// A six-channel AAC track whose layout ffmpeg could not map encodes with
// `channel_layout=unknown`. The CODECS string still reads mp4a.40.2, so the
// browser reports the codec as supported, creates the source buffers, and then
// refuses the bytes — and the room dies claiming the browser cannot decode a
// plain H.264 video. Stereo is the one configuration that never does this.
func TestAudioIsDownmixedToStereo(t *testing.T) {
	probe := &ProbeResult{
		VideoCopyable: true,
		VideoHeight:   1080,
		Audio: []room.TrackInfo{
			{Index: 0, Language: "por", Codec: "ac3"},
			{Index: 1, Language: "eng", Codec: "ac3"},
		},
	}
	args, _ := buildStreamMapping(probe, true)
	joined := strings.Join(args, " ")
	require.Contains(t, joined, "-c:a aac")
	require.Contains(t, joined, "-ac 2")
}

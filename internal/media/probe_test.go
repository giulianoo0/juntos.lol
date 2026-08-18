package media

import (
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestParseProbe(t *testing.T) {
	data, err := os.ReadFile("testdata/probe-mkv.json")
	require.NoError(t, err)

	p, err := parseProbe(data)
	require.NoError(t, err)
	require.Equal(t, int64(734500), p.DurationMs)
	require.Equal(t, "h264", p.VideoCodec)
	require.True(t, p.VideoCopyable)
	require.Len(t, p.Audio, 2)
	require.Equal(t, 0, p.Audio[0].Index)
	require.Equal(t, "eng", p.Audio[0].Language)
	require.Equal(t, "English", p.Audio[0].Title)
	require.Equal(t, "aac", p.Audio[0].Codec)
	require.Equal(t, 1, p.Audio[1].Index)
	require.Equal(t, "jpn", p.Audio[1].Language)
	require.Len(t, p.Subtitles, 1)
	require.Equal(t, 0, p.Subtitles[0].Index)
	require.Equal(t, 1, p.BitmapSubs)
}

func TestParseProbeClassifiesVideoAndSubtitleCodecs(t *testing.T) {
	tests := []struct {
		name              string
		videoCodec        string
		wantCopyable      bool
		wantSubtitleIndex int
	}{
		{name: "hevc is copyable", videoCodec: "hevc", wantCopyable: true, wantSubtitleIndex: 1},
		{name: "vp9 needs transcoding", videoCodec: "vp9", wantCopyable: false, wantSubtitleIndex: 1},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			data := []byte(`{
				"streams": [
					{"codec_name":"` + tt.videoCodec + `","codec_type":"video"},
					{"codec_name":"dvd_subtitle","codec_type":"subtitle"},
					{"codec_name":"ass","codec_type":"subtitle","tags":{"language":"por","title":"Português"}},
					{"codec_name":"mov_text","codec_type":"subtitle"},
					{"codec_name":"unknown_subtitle","codec_type":"subtitle"}
				],
				"format":{"duration":"1.001"}
			}`)

			got, err := parseProbe(data)
			require.NoError(t, err)
			require.Equal(t, tt.videoCodec, got.VideoCodec)
			require.Equal(t, tt.wantCopyable, got.VideoCopyable)
			require.Equal(t, int64(1001), got.DurationMs)
			require.Equal(t, 1, got.BitmapSubs)
			require.Len(t, got.Subtitles, 2)
			require.Equal(t, tt.wantSubtitleIndex, got.Subtitles[0].Index)
			require.Equal(t, 2, got.Subtitles[1].Index)
		})
	}
}

func TestParseProbeToleratesMissingDuration(t *testing.T) {
	for _, data := range []string{`{"streams":[],"format":{}}`, `{"streams":[],"format":{"duration":""}}`} {
		p, err := parseProbe([]byte(data))
		require.NoError(t, err)
		require.Equal(t, int64(0), p.DurationMs)
	}
}

func TestParseProbeRejectsMalformedOutput(t *testing.T) {
	tests := []struct {
		name string
		data string
	}{
		{name: "invalid JSON", data: `{`},
		{name: "invalid duration", data: `{"format":{"duration":"not-a-number"}}`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := parseProbe([]byte(tt.data))
			require.Error(t, err)
		})
	}
}

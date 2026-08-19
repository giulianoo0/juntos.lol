package media

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/room"
)

func heights(ladder []Rendition) []int {
	out := make([]int, 0, len(ladder))
	for _, rendition := range ladder {
		out = append(out, rendition.Height)
	}
	return out
}

func TestRenditionLadderOffersEverySizeA1080pSourceCanFill(t *testing.T) {
	ladder := RenditionLadder(&ProbeResult{VideoHeight: 1080, VideoCopyable: true})

	require.Equal(t, []int{1080, 720, 480, 360}, heights(ladder))
	// The source is already within the cap, so the top rung costs no encoding.
	require.True(t, ladder[0].Copy)
	for _, rendition := range ladder[1:] {
		require.False(t, rendition.Copy)
	}
}

func TestRenditionLadderNeverUpscales(t *testing.T) {
	// A 480p source has no 720p to offer, and inventing one would spend CPU
	// and bandwidth to deliver a blurrier picture than the original.
	require.Equal(t, []int{480, 360}, heights(RenditionLadder(&ProbeResult{VideoHeight: 480, VideoCopyable: true})))
	require.Equal(t, []int{360}, heights(RenditionLadder(&ProbeResult{VideoHeight: 360, VideoCopyable: true})))
	require.Equal(t, []int{720, 480, 360}, heights(RenditionLadder(&ProbeResult{VideoHeight: 720, VideoCopyable: true})))
}

func TestRenditionLadderCapsOversizedSourcesAt1080p(t *testing.T) {
	for _, sourceHeight := range []int{1440, 2160} {
		ladder := RenditionLadder(&ProbeResult{VideoHeight: sourceHeight, VideoCopyable: true})

		require.Equal(t, []int{1080, 720, 480, 360}, heights(ladder), "source %d", sourceHeight)
		// Handing over the original would cost the VPS far more bandwidth than
		// the picture is worth, so even the top rung is re-encoded here.
		require.False(t, ladder[0].Copy, "source %d was passed through", sourceHeight)
	}
}

func TestRenditionLadderWithoutAKnownHeightStaysAsItWas(t *testing.T) {
	ladder := RenditionLadder(&ProbeResult{VideoCopyable: true})

	require.Len(t, ladder, 1)
	require.True(t, ladder[0].Copy)
	require.Zero(t, ladder[0].Height)
}

func TestRenditionLadderTranscodesAnUncopyableTopRung(t *testing.T) {
	// VP9 or AV1 at 720p: the ladder shape is the same, the top just cannot
	// be passed through.
	ladder := RenditionLadder(&ProbeResult{VideoHeight: 720, VideoCopyable: false})

	require.Equal(t, []int{720, 480, 360}, heights(ladder))
	require.False(t, ladder[0].Copy)
	require.Positive(t, ladder[0].BitrateKbps)
}

func TestRemuxArgsPublishEveryRungAgainstOneAudioGroup(t *testing.T) {
	probe := &ProbeResult{
		VideoCodec: "h264", VideoCopyable: true, VideoHeight: 1080,
		Audio: []room.TrackInfo{{Index: 0, Language: "jpn"}},
	}
	args := BuildRemuxArgs("in.mkv", "/out", probe)
	joined := strings.Join(args, " ")

	// One decode feeds all three scaled rungs.
	require.Contains(t, joined, "-filter_complex [0:v]split=3[s0][s1][s2]")
	require.Contains(t, joined, "scale=-2:720[v0]")
	require.Contains(t, joined, "scale=-2:480[v1]")
	require.Contains(t, joined, "scale=-2:360[v2]")
	require.Contains(t, joined, "-c:v:0 copy")

	// Every rung points at the same audio group, so changing picture quality
	// never disturbs the audio track a viewer picked.
	for _, variant := range []string{"v:0,agroup:audio", "v:1,agroup:audio", "v:2,agroup:audio", "v:3,agroup:audio"} {
		require.Contains(t, joined, variant)
	}
}

func TestProgressiveRemuxStaysASingleRendition(t *testing.T) {
	probe := &ProbeResult{VideoCodec: "h264", VideoCopyable: true, VideoHeight: 1080}
	joined := strings.Join(BuildProgressiveRemuxArgs("pipe:0", "/out", probe), " ")

	// The preview exists to make a room playable within seconds; encoding a
	// ladder there would spend exactly the head start it is for.
	require.NotContains(t, joined, "filter_complex")
	require.Contains(t, joined, "-c:v:0 copy")
	require.Contains(t, joined, "-var_stream_map v:0")
}

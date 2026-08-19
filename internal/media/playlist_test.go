package media

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestNormalizeEventPlaylistStartsAGrowingEpisodeAtItsBeginning(t *testing.T) {
	// Without EXT-X-START a native player joins a growing event playlist at
	// its live edge, which for a preview means partway into the episode.
	out := string(normalizeEventPlaylist([]byte(
		"#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:2.000000,\nsegment.m4s\n")))

	require.Contains(t, out, "#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n")
}

func TestNormalizeEventPlaylistRaisesATooSmallTargetDuration(t *testing.T) {
	// ffmpeg occasionally declares a target shorter than a segment that ran a
	// few milliseconds over, which players reject as a malformed playlist.
	out := string(normalizeEventPlaylist([]byte(
		"#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:2.005333,\nsegment.m4s\n")))

	require.Contains(t, out, "#EXT-X-TARGETDURATION:3\n")
}

func TestNormalizeEventPlaylistLeavesAFinishedPlaylistAlone(t *testing.T) {
	vod := "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:6.000000,\nsegment.m4s\n"

	require.Equal(t, vod, string(normalizeEventPlaylist([]byte(vod))))
}

func TestNormalizeEventPlaylistKeepsAnExistingStartTag(t *testing.T) {
	playlist := "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n" +
		"#EXT-X-TARGETDURATION:2\n#EXTINF:2.000000,\nsegment.m4s\n"

	out := string(normalizeEventPlaylist([]byte(playlist)))

	require.Equal(t, 1, strings.Count(out, "#EXT-X-START:"))
}

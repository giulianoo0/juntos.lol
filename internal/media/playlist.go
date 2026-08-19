package media

import (
	"math"
	"strconv"
	"strings"
)

// normalizeEventPlaylist makes a growing episode start at its beginning in
// native HLS players and repairs ffmpeg's occasionally too-small target
// duration for AAC segments that run a few milliseconds over the boundary.
func normalizeEventPlaylist(playlist []byte) []byte {
	text := string(playlist)
	if !strings.Contains(text, "#EXT-X-PLAYLIST-TYPE:EVENT") {
		return playlist
	}

	lines := strings.Split(strings.TrimSuffix(text, "\n"), "\n")
	targetIndex := -1
	targetDuration := 0
	maxSegmentDuration := 0.0
	hasStart := false
	for index, line := range lines {
		switch {
		case strings.HasPrefix(line, "#EXT-X-TARGETDURATION:"):
			targetIndex = index
			targetDuration, _ = strconv.Atoi(strings.TrimPrefix(line, "#EXT-X-TARGETDURATION:"))
		case strings.HasPrefix(line, "#EXTINF:"):
			value := strings.TrimPrefix(line, "#EXTINF:")
			value, _, _ = strings.Cut(value, ",")
			if duration, err := strconv.ParseFloat(value, 64); err == nil {
				maxSegmentDuration = max(maxSegmentDuration, duration)
			}
		case strings.HasPrefix(line, "#EXT-X-START:"):
			hasStart = true
		}
	}

	minimumTarget := int(math.Ceil(maxSegmentDuration))
	if targetIndex >= 0 && targetDuration < minimumTarget {
		lines[targetIndex] = "#EXT-X-TARGETDURATION:" + strconv.Itoa(minimumTarget)
	}
	if !hasStart {
		for index, line := range lines {
			if line == "#EXT-X-PLAYLIST-TYPE:EVENT" {
				lines = append(lines[:index+1], append([]string{"#EXT-X-START:TIME-OFFSET=0,PRECISE=YES"}, lines[index+1:]...)...)
				break
			}
		}
	}
	return []byte(strings.Join(lines, "\n") + "\n")
}

// Package sync defines the watch-room synchronization protocol and position math.
package sync

import (
	"math"

	"github.com/giulianoo0/ss/internal/room"
)

const DriftThresholdMs int64 = 450

// ExpectedPositionMs projects the shared position to nowServerMs.
func ExpectedPositionMs(st room.PlayState, nowServerMs int64) int64 {
	position := float64(st.PositionMs)
	if st.Playing && !math.IsNaN(st.Rate) && !math.IsInf(st.Rate, 0) {
		position += elapsedMilliseconds(nowServerMs, st.ServerTimeMs) * st.Rate
	}
	if position <= 0 {
		return 0
	}
	if position >= math.MaxInt64 {
		return math.MaxInt64
	}
	return int64(position)
}

func elapsedMilliseconds(nowMs, thenMs int64) float64 {
	if nowMs >= thenMs {
		return float64(uint64(nowMs) - uint64(thenMs))
	}
	return -float64(uint64(thenMs) - uint64(nowMs))
}

// NeedsResync reports whether local and expected positions differ too much.
func NeedsResync(localMs, expectedMs int64) bool {
	var difference uint64
	if localMs >= expectedMs {
		difference = uint64(localMs) - uint64(expectedMs)
	} else {
		difference = uint64(expectedMs) - uint64(localMs)
	}
	return difference > uint64(DriftThresholdMs)
}

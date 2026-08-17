package sync

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/room"
)

func TestExpectedPositionWhilePlaying(t *testing.T) {
	st := room.PlayState{Playing: true, PositionMs: 10_000, Rate: 1, ServerTimeMs: 1_000_000}
	require.Equal(t, int64(12_000), ExpectedPositionMs(st, 1_002_000))
}

func TestExpectedPositionUsesPlaybackRate(t *testing.T) {
	st := room.PlayState{Playing: true, PositionMs: 10_000, Rate: 1.5, ServerTimeMs: 1_000_000}
	require.Equal(t, int64(13_000), ExpectedPositionMs(st, 1_002_000))
}

func TestExpectedPositionPaused(t *testing.T) {
	st := room.PlayState{Playing: false, PositionMs: 10_000, Rate: 1, ServerTimeMs: 1_000_000}
	require.Equal(t, int64(10_000), ExpectedPositionMs(st, 1_999_999))
}

func TestExpectedPositionClampsAtZero(t *testing.T) {
	st := room.PlayState{Playing: true, PositionMs: 100, Rate: 1, ServerTimeMs: 2_000}
	require.Zero(t, ExpectedPositionMs(st, 1_000))
}

func TestNeedsResync(t *testing.T) {
	require.False(t, NeedsResync(10_000, 10_400))
	require.False(t, NeedsResync(10_000, 10_450))
	require.True(t, NeedsResync(10_000, 10_451))
	require.True(t, NeedsResync(10_451, 10_000))
}

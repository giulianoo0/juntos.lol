package sync

import (
	"math"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/room"
)

func TestExpectedPositionMs(t *testing.T) {
	tests := []struct {
		name  string
		state room.PlayState
		now   int64
		want  int64
	}{
		{"advances while playing", room.PlayState{Playing: true, PositionMs: 10_000, Rate: 1, ServerTimeMs: 1_000_000}, 1_002_000, 12_000},
		{"follows the playback rate", room.PlayState{Playing: true, PositionMs: 10_000, Rate: 1.5, ServerTimeMs: 1_000_000}, 1_002_000, 13_000},
		{"stays put while paused", room.PlayState{PositionMs: 10_000, Rate: 1, ServerTimeMs: 1_000_000}, 1_999_999, 10_000},
		{"never goes below zero", room.PlayState{Playing: true, PositionMs: 100, Rate: 1, ServerTimeMs: 2_000}, 1_000, 0},
		{"keeps a small delta at a huge timestamp", room.PlayState{Playing: true, PositionMs: 10, Rate: 1, ServerTimeMs: math.MaxInt64 - 1}, math.MaxInt64, 11},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			require.Equal(t, tt.want, ExpectedPositionMs(tt.state, tt.now))
		})
	}
}

func TestNeedsResync(t *testing.T) {
	require.False(t, NeedsResync(10_000, 10_400))
	require.False(t, NeedsResync(10_000, 10_450))
	require.True(t, NeedsResync(10_000, 10_451))
	require.True(t, NeedsResync(10_451, 10_000))
}

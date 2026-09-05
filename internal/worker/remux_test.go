package worker

import (
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/remux"
	"github.com/giulianoo0/ss/internal/room"
)

func TestCoveredByRegionsCompletedRunLeavesGapsUncovered(t *testing.T) {
	regions := []room.MediaRegion{
		{N: 0, StartMs: 0, ProducedMs: 536_000},
		{N: 1, StartMs: 1_025_025, ProducedMs: 392_392},
	}
	completed := &RemuxRun{Region: 1, StartMs: 1_025_025, ProducedMs: 392_392, State: remux.RunCompleted}
	require.False(t, coveredByRegions(regions, completed, 700_000), "the gap between regions is uncovered")
	require.True(t, coveredByRegions(regions, completed, 1_100_000), "inside the completed region")
	require.True(t, coveredByRegions(regions, completed, 100_000), "inside the sealed first region")

	require.True(t, coveredByRegions(regions, completed, 1_025_025-followBehindMs), "just before a region is the region")
	require.False(t, coveredByRegions(regions, completed, 1_025_025-followBehindMs-1), "any earlier is the gap")

	live := &RemuxRun{Region: 1, StartMs: 1_025_025, ProducedMs: 100_000, State: remux.RunRunning}
	require.True(t, coveredByRegions(regions, live, 1_125_025+followAheadMs-1), "a live run's edge counts ahead")
	require.False(t, coveredByRegions(regions, completed, 1_417_417+followAheadMs-1), "a finished run has no edge ahead of it")
}

// The player loads a position up to REGION_BEHIND_MS before a region from
// that region; the server must never call covered what the player will not
// load, or nobody dispatches and the room waits forever.
func TestFollowBehindNeverExceedsThePlayersTolerance(t *testing.T) {
	require.LessOrEqual(t, int64(followBehindMs), int64(1_000))
}

func TestAdmitFollowHoldsTheLatestPositionInsideTheWindow(t *testing.T) {
	o := &RemuxOrchestrator{byRoom: map[string]*sync.Mutex{}, follows: map[string]*followState{}, followDebounce: 40 * time.Millisecond}
	require.True(t, o.admitFollow("r1", 1_000), "the first position acts at once")
	require.False(t, o.admitFollow("r1", 2_000), "inside the window it waits")
	require.False(t, o.admitFollow("r1", 3_000), "and the newest one replaces the one waiting")
	o.mu.Lock()
	require.NotNil(t, o.follows["r1"].pending)
	require.Equal(t, int64(3_000), *o.follows["r1"].pending)
	require.NotNil(t, o.follows["r1"].timer)
	o.follows["r1"].timer.Stop()
	o.mu.Unlock()

	time.Sleep(50 * time.Millisecond)
	require.True(t, o.admitFollow("r1", 4_000), "after the window a position acts again")
	require.True(t, o.admitFollow("r2", 5_000), "rooms do not share a window")
}

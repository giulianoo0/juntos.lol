package worker

import (
	"testing"

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

	live := &RemuxRun{Region: 1, StartMs: 1_025_025, ProducedMs: 100_000, State: remux.RunRunning}
	require.True(t, coveredByRegions(regions, live, 1_125_025+followAheadMs-1), "a live run's edge counts ahead")
	require.False(t, coveredByRegions(regions, completed, 1_417_417+followAheadMs-1), "a finished run has no edge ahead of it")
}

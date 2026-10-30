package main

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/worker"
)

func TestSwarmReportsPassOnlyWhatChanged(t *testing.T) {
	reports := newSwarmReports()
	stats := worker.SwarmStats{Peers: 3, HaveBytes: 100}

	require.True(t, reports.changed("r1", stats))
	require.False(t, reports.changed("r1", stats), "the same report twice")
	require.True(t, reports.changed("r2", stats), "rooms do not share a report")
	stats.HaveBytes = 200
	require.True(t, reports.changed("r1", stats))
}

func TestSwarmReportsForgetARoomThatEnded(t *testing.T) {
	reports := newSwarmReports()
	stats := worker.SwarmStats{Peers: 3}
	reports.changed("r1", stats)

	reports.forget("r1")

	require.Empty(t, reports.last)
	require.True(t, reports.changed("r1", stats), "a forgotten room reports afresh")
}

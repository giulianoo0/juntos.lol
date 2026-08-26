package worker

import (
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestFleetRanksTheWayPlacementChooses(t *testing.T) {
	r := newRegistry(t)
	live(r, "loaded", Heartbeat{Leases: 6, MaxLeases: 8, MaxTorrents: 10})
	live(r, "idle", Heartbeat{Leases: 0, MaxLeases: 8, MaxTorrents: 10})
	live(r, "full", Heartbeat{Leases: 8, MaxLeases: 8, MaxTorrents: 10})

	fleet := r.Fleet(time.Now())
	require.Len(t, fleet, 3)
	require.Equal(t, []string{"idle", "loaded", "full"}, []string{fleet[0].ID, fleet[1].ID, fleet[2].ID})
	require.Equal(t, "available", fleet[0].Availability)
	require.Equal(t, "busy", fleet[2].Availability)

	// The page must not disagree with the system it describes: the head of
	// the list is where the next room would actually land.
	placed, err := r.Place(strings.Repeat("a", 40), 0, time.Now())
	require.NoError(t, err)
	require.Equal(t, fleet[0].ID, placed.ID)
}

func TestFleetSeparatesDrainingFromSilent(t *testing.T) {
	r := newRegistry(t)
	live(r, "leaving", Heartbeat{Leases: 1, MaxLeases: 8, Draining: true})
	live(r, "here", Heartbeat{Leases: 1, MaxLeases: 8})

	fleet := r.Fleet(time.Now())
	require.Equal(t, "here", fleet[0].ID)
	require.Equal(t, "available", fleet[0].Availability)
	require.Equal(t, "draining", fleet[1].Availability)

	// A worker that simply stopped reporting is a different thing from one
	// that announced it was leaving, and reads differently on the page.
	silent := r.Fleet(time.Now().Add(2 * time.Minute))
	byID := map[string]string{}
	for _, member := range silent {
		byID[member.ID] = member.Availability
	}
	require.Equal(t, "offline", byID["here"])
	require.Equal(t, "draining", byID["leaving"])
}

func TestFleetReportsTheBudgetsBehindTheVerdict(t *testing.T) {
	r := newRegistry(t)
	live(r, "w1", Heartbeat{
		Version: "0.1.0", UptimeSecs: 3600, Leases: 2, MaxLeases: 8, MaxTorrents: 10,
		Transfer: &TransferStats{CapBps: 1_000_000, UsedBps: 250_000},
		Torrents: []TorrentDigest{{Infohash: strings.Repeat("b", 40)}},
		Disk:     DiskReport{Used: 20 << 30, Real: 320 << 20, Quota: 100 << 30},
	})

	member := r.Fleet(time.Now())[0]
	require.Equal(t, "0.1.0", member.Version)
	require.Equal(t, 2, member.Leases)
	require.Equal(t, 8, member.MaxLeases)
	require.Equal(t, 1, member.Torrents)
	require.Equal(t, int64(20<<30), member.DiskUsed)
	require.Equal(t, int64(250_000), member.TransferUsedBps)
	require.Equal(t, int64(3600), member.UptimeSecs)
	// 2/8 leases at 0.7 and 20/100 disk at 0.3.
	require.InDelta(t, 0.235, member.Load, 0.001)
}

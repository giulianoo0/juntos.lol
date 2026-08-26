package worker

import (
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

func newRegistry(t *testing.T) *Registry {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })
	return NewRegistry(rdb)
}

func live(r *Registry, id string, hb Heartbeat) {
	hb.Ready = true
	l := &link{}
	r.Attach(t0ctx(), id, "pk", "https://"+id, l)
	r.Observe(t0ctx(), id, l, hb)
}

func TestPlacementPrefersAffinityThenLeastLoaded(t *testing.T) {
	r := newRegistry(t)
	ih := strings.Repeat("c", 40)
	live(r, "busy", Heartbeat{Leases: 7, MaxLeases: 8, MaxTorrents: 10})
	live(r, "warm", Heartbeat{Leases: 5, MaxLeases: 8, MaxTorrents: 10, Torrents: []TorrentDigest{{Infohash: ih, HaveBytes: 100}}})
	live(r, "idle", Heartbeat{Leases: 0, MaxLeases: 8, MaxTorrents: 10})

	w, err := r.Place(ih, 0, time.Now())
	require.NoError(t, err)
	require.Equal(t, "warm", w.ID, "a worker holding the hash wins even when busier")

	w, err = r.Place(strings.Repeat("d", 40), 0, time.Now())
	require.NoError(t, err)
	require.Equal(t, "idle", w.ID)
}

func TestPlacementRefusals(t *testing.T) {
	r := newRegistry(t)
	_, err := r.Place(strings.Repeat("e", 40), 0, time.Now())
	require.ErrorIs(t, err, ErrNoWorkers)

	live(r, "full", Heartbeat{Leases: 8, MaxLeases: 8})
	_, err = r.Place(strings.Repeat("e", 40), 0, time.Now())
	require.ErrorIs(t, err, ErrWorkersBusy)

	// Disk: a 10 GB file does not fit a worker with 1 GB left of a 100 GB quota.
	live(r, "tight", Heartbeat{Leases: 0, MaxLeases: 8, Disk: DiskReport{Used: 89 << 30, Quota: 100 << 30}})
	_, err = r.Place(strings.Repeat("e", 40), 10<<30, time.Now())
	require.ErrorIs(t, err, ErrWorkersBusy)
	w, err := r.Place(strings.Repeat("e", 40), 0, time.Now())
	require.NoError(t, err)
	require.Equal(t, "tight", w.ID)

	// Stale: a worker whose heartbeat is old is not healthy, and a fleet
	// with nothing healthy in it is no fleet.
	r.mu.Lock()
	for _, w := range r.workers {
		w.LastSeen = time.Now().Add(-time.Minute)
	}
	r.mu.Unlock()
	_, err = r.Place(strings.Repeat("e", 40), 0, time.Now())
	require.ErrorIs(t, err, ErrNoWorkers)
}

func TestZombieLinkCannotObserve(t *testing.T) {
	r := newRegistry(t)
	old := &link{}
	r.Attach(t0ctx(), "w", "pk", "https://w", old)
	fresh := &link{}
	r.Attach(t0ctx(), "w", "pk", "https://w", fresh)
	require.False(t, r.Observe(t0ctx(), "w", old, Heartbeat{Ready: true}), "the old link's numbers are refused")
	require.True(t, r.Observe(t0ctx(), "w", fresh, Heartbeat{Ready: true}))
}

func TestAffinityDropsWithTheHeartbeat(t *testing.T) {
	r := newRegistry(t)
	ih := strings.Repeat("f", 40)
	live(r, "w", Heartbeat{MaxLeases: 4, Torrents: []TorrentDigest{{Infohash: ih}}})
	require.Len(t, r.Holders(ih, time.Now()), 1)
	live(r, "w", Heartbeat{MaxLeases: 4})
	require.Empty(t, r.Holders(ih, time.Now()), "the torrent left the heartbeat, so it left the table")
}

func TestPlacementRefusesAWorkerNearItsBandwidthCeiling(t *testing.T) {
	r := newRegistry(t)
	hot := Heartbeat{Leases: 0, MaxLeases: 8, Transfer: &TransferStats{CapBps: 75_000_000, UsedBps: 70_000_000}}
	live(r, "hot", hot)
	_, err := r.Place(strings.Repeat("f", 40), 0, time.Now())
	require.ErrorIs(t, err, ErrWorkersBusy)

	cool := Heartbeat{Leases: 0, MaxLeases: 8, Transfer: &TransferStats{CapBps: 75_000_000, UsedBps: 10_000_000}}
	live(r, "cool", cool)
	w, err := r.Place(strings.Repeat("f", 40), 0, time.Now())
	require.NoError(t, err)
	require.Equal(t, "cool", w.ID)
}

func TestPlacementLeavesRelayedWorkersForLast(t *testing.T) {
	// Every byte a relayed worker serves crosses this machine three times on
	// its way to the browser, so it loses to a direct one however lightly
	// loaded it is. A page that measured the paths sends its own ranking and
	// overrides this.
	r := newRegistry(t)
	ih := strings.Repeat("d", 40)
	live(r, "relayed", Heartbeat{Leases: 0, MaxLeases: 8, MaxTorrents: 10, Relayed: true})
	live(r, "direct", Heartbeat{Leases: 6, MaxLeases: 8, MaxTorrents: 10})

	w, err := r.Place(ih, 0, time.Now())
	require.NoError(t, err)
	require.Equal(t, "direct", w.ID)
}

func TestPlacementTakesARelayedWorkerWhenItIsTheOnlyOne(t *testing.T) {
	r := newRegistry(t)
	live(r, "relayed", Heartbeat{Leases: 0, MaxLeases: 8, MaxTorrents: 10, Relayed: true})

	w, err := r.Place(strings.Repeat("e", 40), 0, time.Now())
	require.NoError(t, err)
	require.Equal(t, "relayed", w.ID)
}

func TestPlacementPrefersADirectHolderOverARelayedOne(t *testing.T) {
	r := newRegistry(t)
	ih := strings.Repeat("f", 40)
	held := []TorrentDigest{{Infohash: ih, HaveBytes: 100}}
	live(r, "relayed-warm", Heartbeat{Leases: 0, MaxLeases: 8, MaxTorrents: 10, Relayed: true, Torrents: held})
	live(r, "direct-warm", Heartbeat{Leases: 6, MaxLeases: 8, MaxTorrents: 10, Torrents: held})

	w, err := r.Place(ih, 0, time.Now())
	require.NoError(t, err)
	require.Equal(t, "direct-warm", w.ID)
}

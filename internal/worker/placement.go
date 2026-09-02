package worker

import (
	"errors"
	"time"
)

var ErrNoWorkers = errors.New("no_workers")

var ErrWorkersBusy = errors.New("workers_busy")

// Place picks the worker for an infohash: hard filters (healthy, disk with
// slack, leases under max), then affinity to a worker already holding the
// torrent, then least loaded. Never round-robin: jobs run for hours.
func (r *Registry) Place(infohash string, sizeHint int64, now time.Time) (Worker, error) {
	if holders := r.Holders(infohash, now); len(holders) > 0 {
		for _, relayed := range []bool{false, true} {
			for _, w := range holders {
				if w.Heartbeat.Relayed == relayed && hasRoom(w, 0) {
					return w, nil
				}
			}
		}
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	var best *Worker
	bestLoad := 2.0
	healthy := 0
	for _, w := range r.workers {
		if !w.Healthy(now) {
			continue
		}
		healthy++
		if !hasRoom(*w, sizeHint) {
			continue
		}
		load := loadOf(*w)
		if best == nil || better(*w, load, *best, bestLoad) {
			best, bestLoad = w, load
		}
	}
	if best == nil {
		if healthy == 0 {
			return Worker{}, ErrNoWorkers
		}
		return Worker{}, ErrWorkersBusy
	}
	return *best, nil
}

// better ranks a candidate against the standing best: direct before relayed,
// then least loaded.
func better(candidate Worker, candidateLoad float64, best Worker, bestLoad float64) bool {
	if candidate.Heartbeat.Relayed != best.Heartbeat.Relayed {
		return !candidate.Heartbeat.Relayed
	}
	return candidateLoad < bestLoad
}

// hasRoom checks the worker's own reported budgets. A size hint of zero
// (unknown before the listing) only needs some disk left at all.
func hasRoom(w Worker, sizeHint int64) bool {
	hb := w.Heartbeat
	if hb.MaxLeases > 0 && hb.Leases >= hb.MaxLeases {
		return false
	}
	if hb.MaxTorrents > 0 && len(hb.Torrents) >= hb.MaxTorrents {
		return false
	}
	if hb.Disk.Quota > 0 {
		need := sizeHint + sizeHint/5
		if hb.Disk.Used+need > hb.Disk.Quota*9/10 {
			return false
		}
	}
	if hb.Transfer != nil && hb.Transfer.CapBps > 0 && hb.Transfer.UsedBps >= hb.Transfer.CapBps*85/100 {
		return false
	}
	return true
}

// loadOf composes lease pressure and disk pressure into one number.
func loadOf(w Worker) float64 {
	hb := w.Heartbeat
	var leases, disk float64
	if hb.MaxLeases > 0 {
		leases = float64(hb.Leases) / float64(hb.MaxLeases)
	}
	if hb.Disk.Quota > 0 {
		disk = float64(hb.Disk.Used) / float64(hb.Disk.Quota)
	}
	return leases*0.7 + disk*0.3
}

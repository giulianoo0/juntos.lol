package worker

import (
	"errors"
	"time"
)

// ErrNoWorkers means no worker is enrolled and connected at all.
var ErrNoWorkers = errors.New("no_workers")

// ErrWorkersBusy means workers exist but none has room for this job.
var ErrWorkersBusy = errors.New("workers_busy")

// Place picks the worker for an infohash: hard filters (healthy, disk for
// the file with slack, leases under max), then affinity — a worker that
// already holds the torrent serves the next episode or a rewatch from warm
// pieces — then least loaded. Never round-robin: jobs run for hours and are
// nothing alike.
func (r *Registry) Place(infohash string, sizeHint int64, now time.Time) (Worker, error) {
	if holders := r.Holders(infohash, now); len(holders) > 0 {
		for _, w := range holders {
			if hasRoom(w, 0) {
				return w, nil
			}
		}
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	if len(r.workers) == 0 {
		return Worker{}, ErrNoWorkers
	}
	var best *Worker
	bestLoad := 2.0
	for _, w := range r.workers {
		if !w.Healthy(now) || !hasRoom(*w, sizeHint) {
			continue
		}
		load := loadOf(*w)
		if best == nil || load < bestLoad {
			best, bestLoad = w, load
		}
	}
	if best == nil {
		return Worker{}, ErrWorkersBusy
	}
	return *best, nil
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

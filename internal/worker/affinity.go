package worker

import "time"

// Holders lists the healthy workers whose last heartbeat reported the
// infohash, warmest first, so a worker that reaped the torrent drops out
// within one beat.
func (r *Registry) Holders(infohash string, now time.Time) []Worker {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var out []Worker
	for _, w := range r.workers {
		if !w.Healthy(now) {
			continue
		}
		if _, ok := w.Holds(infohash); ok {
			out = append(out, *w)
		}
	}
	sortByWarmth(out, infohash)
	return out
}

func sortByWarmth(workers []Worker, infohash string) {
	for i := 1; i < len(workers); i++ {
		for j := i; j > 0; j-- {
			a, _ := workers[j].Holds(infohash)
			b, _ := workers[j-1].Holds(infohash)
			if a.HaveBytes > b.HaveBytes {
				workers[j], workers[j-1] = workers[j-1], workers[j]
			} else {
				break
			}
		}
	}
}

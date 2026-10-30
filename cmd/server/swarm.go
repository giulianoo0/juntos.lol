package main

import (
	"sync"

	"github.com/giulianoo0/ss/internal/worker"
)

// swarmReports remembers the last swarm each room's worker reported, so a
// heartbeat that says the same thing again writes nothing. A room leaves it
// when its media is cancelled or the room ends.
type swarmReports struct {
	mu   sync.Mutex
	last map[string]worker.SwarmStats
}

func newSwarmReports() *swarmReports {
	return &swarmReports{last: map[string]worker.SwarmStats{}}
}

// changed records stats and reports whether they differ from the last ones.
func (s *swarmReports) changed(roomID string, stats worker.SwarmStats) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	previous, ok := s.last[roomID]
	s.last[roomID] = stats
	return !ok || previous != stats
}

func (s *swarmReports) forget(roomID string) {
	s.mu.Lock()
	delete(s.last, roomID)
	s.mu.Unlock()
}

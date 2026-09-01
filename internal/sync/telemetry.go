package sync

// What each viewer's playback looked like against the room's authoritative
// clock, kept so a desync complaint is answerable after the fact from the
// server logs alone. The steady "ready" reports already carry position,
// buffer and stall; this is the side that finally reads them.

import (
	"context"
	"log/slog"
	"time"

	"github.com/giulianoo0/ss/internal/metrics"
)

// driftLogMs is how far a viewer may run from the room's clock before a
// report earns a log line of its own. The client corrects itself at 450ms,
// so a report past this survived a correction cycle — that is the story
// worth a line while it happens.
const driftLogMs = 1000

type syncTelemetry struct {
	joinedAt       time.Time
	reports        int64
	stalls         int64
	wasStalled     bool
	driftedReports int64
	lastDriftMs    int64
	maxAbsDriftMs  int64
}

// recordSync folds one steady report into the member's running story and
// logs the excursions as they happen: the start of every stall, and any
// report that sits over a second from where the room says it should be.
func (r *roomConn) recordSync(ctx context.Context, c *client, m Inbound, now int64) {
	t := &c.telemetry
	t.reports++
	if m.Stalled && !t.wasStalled {
		t.stalls++
		slog.InfoContext(ctx, "viewer stalled",
			"room_id", r.id, "member", c.member.Nickname,
			"position_ms", m.PositionMs, "buffer_ms", m.BufferAheadMs)
	}
	t.wasStalled = m.Stalled
	// Drift only means something against a moving clock: while gated or
	// paused, everyone is where they are on purpose.
	if r.gate != nil {
		return
	}
	state, err := r.hub.store.GetState(ctx, r.id)
	if err != nil || !state.Playing {
		return
	}
	drift := m.PositionMs - ExpectedPositionMs(state, now)
	t.lastDriftMs = drift
	abs := drift
	if abs < 0 {
		abs = -abs
	}
	if abs > t.maxAbsDriftMs {
		t.maxAbsDriftMs = abs
	}
	metrics.SyncDrift.Observe(float64(abs) / 1000)
	if abs > driftLogMs {
		t.driftedReports++
		slog.InfoContext(ctx, "viewer drifted",
			"room_id", r.id, "member", c.member.Nickname,
			"drift_ms", drift, "buffer_ms", m.BufferAheadMs, "stalled", m.Stalled)
	}
}

// logSyncSummary is the member's whole session in one line, written as they
// leave — the line to grep when someone says a room would not stay in sync.
func (r *roomConn) logSyncSummary(c *client) {
	t := &c.telemetry
	if t.reports == 0 {
		return
	}
	slog.Info("viewer sync summary",
		"room_id", r.id, "member", c.member.Nickname,
		"watched", time.Since(t.joinedAt).Round(time.Second).String(),
		"reports", t.reports, "stalls", t.stalls,
		"drifted_reports", t.driftedReports,
		"max_drift_ms", t.maxAbsDriftMs, "last_drift_ms", t.lastDriftMs)
}

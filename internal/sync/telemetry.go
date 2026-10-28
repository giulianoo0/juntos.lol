package sync

// What each viewer's playback looked like against the room's authoritative
// clock, kept so a desync complaint is answerable from the server logs alone.

import (
	"context"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/giulianoo0/ss/internal/usage"
)

const driftLogMs = 1000

type syncTelemetry struct {
	joinedAt       time.Time
	reports        int64
	stalls         int64
	wasStalled     bool
	driftedReports int64
	lastDriftMs    int64
	maxAbsDriftMs  int64

	device        string
	mediaKbps     int64
	bandwidthSum  int64
	bandwidthN    int64
	bandwidthMin  int64
	lastBandwidth int64
	droppedFrames int64
	decodedFrames int64
}

// deviceClass names the kind of browser a socket came from, coarsely enough
// to tell a phone's stalls from a desktop's in the logs.
func deviceClass(userAgent string) string {
	ua := strings.ToLower(userAgent)
	switch {
	case strings.Contains(ua, "iphone"):
		return "iphone"
	case strings.Contains(ua, "ipad"):
		return "ipad"
	case strings.Contains(ua, "android"):
		return "android"
	case ua == "":
		return "unknown"
	default:
		return "desktop"
	}
}

// recordHealth keeps what the viewer's player measured about its own link.
func (t *syncTelemetry) recordHealth(m Inbound) {
	if m.MediaKbps > 0 {
		t.mediaKbps = m.MediaKbps
	}
	if m.BandwidthKbps > 0 {
		t.lastBandwidth = m.BandwidthKbps
		t.bandwidthSum += m.BandwidthKbps
		t.bandwidthN++
		if t.bandwidthMin == 0 || m.BandwidthKbps < t.bandwidthMin {
			t.bandwidthMin = m.BandwidthKbps
		}
	}
	if m.DecodedFrames > 0 {
		t.droppedFrames = m.DroppedFrames
		t.decodedFrames = m.DecodedFrames
	}
}

func (t *syncTelemetry) bandwidthAvg() int64 {
	if t.bandwidthN == 0 {
		return 0
	}
	return t.bandwidthSum / t.bandwidthN
}

// droppedPermille is the share of frames the decoder could not show in time, in
// tenths of a percent: a weak device drops frames long before it stalls.
func (t *syncTelemetry) droppedPermille() int64 {
	if t.decodedFrames <= 0 {
		return 0
	}
	return t.droppedFrames * 1000 / t.decodedFrames
}

// recordSync folds one steady report into the member's running story and
// logs the excursions as they happen: the start of every stall, and any
// report that sits over a second from where the room says it should be.
func (r *roomConn) recordSync(ctx context.Context, c *client, m Inbound, now int64) {
	t := &c.telemetry
	t.reports++
	t.recordHealth(m)
	if m.Stalled && !t.wasStalled {
		t.stalls++
		slog.InfoContext(ctx, "viewer stalled",
			"room_id", r.id, "member", c.member.Nickname, "device", t.device,
			"position_ms", m.PositionMs, "buffer_ms", m.BufferAheadMs,
			"bandwidth_kbps", t.lastBandwidth, "media_kbps", t.mediaKbps)
	}
	t.wasStalled = m.Stalled
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
		"max_drift_ms", t.maxAbsDriftMs, "last_drift_ms", t.lastDriftMs,
		"device", t.device, "media_kbps", t.mediaKbps,
		"bandwidth_avg_kbps", t.bandwidthAvg(), "bandwidth_min_kbps", t.bandwidthMin,
		"dropped_permille", t.droppedPermille())
}

// countEntered tells the day's tally someone took a seat: the browser's own
// random id and the account number go in hashed, as package usage keeps them.
func (r *roomConn) countEntered(c *client) {
	r.hub.usage.Add(usage.Metrics{"room_joins": 1})
	r.hub.usage.Distinct("room_people", c.device)
	if c.member.AccountID != 0 {
		r.hub.usage.Distinct("room_accounts", strconv.FormatInt(c.member.AccountID, 10))
	}
}

// countStay folds a finished seat into the day: how long, on what, how the
// link held up.
func (r *roomConn) countStay(c *client) {
	t := &c.telemetry
	metrics := usage.Metrics{
		"room_sessions":      1,
		"room_seconds":       int64(time.Since(c.member.JoinedAt) / time.Second),
		"device_" + t.device: 1,
	}
	if t.stalls > 0 {
		metrics["stalls"] = t.stalls
	}
	if avg := t.bandwidthAvg(); avg > 0 {
		metrics["viewer_kbps_sum"] = avg
		metrics["viewer_kbps_n"] = 1
	}
	if t.mediaKbps > 0 {
		metrics["media_kbps_sum"] = t.mediaKbps
		metrics["media_kbps_n"] = 1
	}
	if c.member.AccountID != 0 {
		metrics["signed_in_sessions"] = 1
	}
	r.hub.usage.Add(metrics)
}

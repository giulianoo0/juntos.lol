package sync

import (
	"context"
	"log/slog"
	"time"

	"github.com/giulianoo0/ss/internal/room"
)

const (
	// GateReadyBufferMs is the contiguous buffer a member must hold ahead of
	// the target position before a gated start counts them as ready.
	GateReadyBufferMs int64 = 3000
	// GateMaxWait bounds every gated start. A frozen tab or a dead decoder
	// never reports ready, and the room must not hang on it forever.
	GateMaxWait = 20 * time.Second
	// gatePositionSlackMs is how far a report's position may sit from the
	// target before its buffer describes the wrong part of the media.
	gatePositionSlackMs int64 = 2000
)

// memberReport is the latest readiness a client reported. Only the room
// goroutine reads or writes it.
type memberReport struct {
	positionMs    int64
	bufferAheadMs int64
	stalled       bool
	received      bool
}

// playGate is a pending synchronized start: the room is parked paused at the
// target and playback is released to everyone at once, on quorum or timeout.
type playGate struct {
	targetMs int64
	// rate is only a fallback for a release that cannot re-read the store.
	rate  float64
	timer *time.Timer
}

// shouldGate reports whether a controller play or seek must wait for the
// room to buffer. The room is read fresh because the setting and the source
// can both change while this connection lives.
func (r *roomConn) shouldGate(ctx context.Context) bool {
	// Alone in the room there is nobody to start together with.
	if len(r.clients) < 2 {
		return false
	}
	storedRoom, err := r.hub.store.Get(ctx, r.id)
	if err != nil {
		// Playback must not fail closed on a store hiccup.
		slog.ErrorContext(ctx, "load room for gate decision failed", "room_id", r.id, "error", err)
		return false
	}
	// A live screen has nothing to buffer.
	return storedRoom.GatingEnabled && storedRoom.SourceKind != room.SourceScreen
}

// openGate parks the room paused at targetMs and starts waiting for every
// member to buffer it. state must already carry the rate to resume with.
func (r *roomConn) openGate(ctx context.Context, sender *client, targetMs int64, state room.PlayState, now int64) {
	// Members can only buffer the start point once they are parked on it, so
	// the paused target is persisted and broadcast before anyone is asked to
	// report readiness.
	state.Playing = false
	state.PositionMs = targetMs
	state.ServerTimeMs = now
	if err := r.hub.store.SetState(ctx, r.id, state); err != nil {
		slog.ErrorContext(ctx, "persist gated state failed", "room_id", r.id, "error", err)
		r.send(sender, Outbound{Type: "error", ErrCode: "internal_error"})
		return
	}
	stateCopy := state
	r.broadcast(Outbound{Type: "state", State: &stateCopy})
	if r.gate == nil {
		r.gate = &playGate{timer: time.NewTimer(r.hub.gateTimeout)}
	} else {
		// Retargeting mid-wait is a controller action and restarts the clock;
		// only joins must never touch it.
		if !r.gate.timer.Stop() {
			select {
			case <-r.gate.timer.C:
			default:
			}
		}
		r.gate.timer.Reset(r.hub.gateTimeout)
	}
	r.gate.targetMs = targetMs
	r.gate.rate = state.Rate
	// Everyone may already hold the target buffered — a resume after a short
	// pause — and then there is nothing to wait for.
	if !r.evaluateGate() {
		r.broadcastWaiting()
	}
}

// evaluateGate releases the gate when every connected member is ready and
// reports whether it did.
func (r *roomConn) evaluateGate() bool {
	if r.gate == nil {
		return false
	}
	for _, connected := range r.clients {
		if !r.clientReady(connected) {
			return false
		}
	}
	r.releaseGate()
	return true
}

func (r *roomConn) clientReady(connected *client) bool {
	report := connected.report
	if !report.received || report.stalled {
		return false
	}
	drift := report.positionMs - r.gate.targetMs
	if drift < 0 {
		drift = -drift
	}
	return drift <= gatePositionSlackMs && report.bufferAheadMs >= GateReadyBufferMs
}

// releaseGate starts playback for everyone at once at the gated target.
func (r *roomConn) releaseGate() {
	gate := r.gate
	if gate == nil {
		return
	}
	r.gate = nil
	gate.timer.Stop()
	ctx, cancel := context.WithTimeout(r.hub.ctx, storeTimeout)
	defer cancel()
	state, err := r.hub.store.GetState(ctx, r.id)
	if err != nil {
		slog.ErrorContext(ctx, "load state for gate release failed", "room_id", r.id, "error", err)
		state = room.PlayState{Rate: gate.rate}
	}
	if state.Rate == 0 {
		state.Rate = 1
	}
	state.Playing = true
	state.PositionMs = gate.targetMs
	state.ServerTimeMs = time.Now().UnixMilli()
	if err := r.hub.store.SetState(ctx, r.id, state); err != nil {
		// Broadcast anyway: a stale store heals on the next command, but
		// clients left in the waiting state would sit paused forever.
		slog.ErrorContext(ctx, "persist gate release failed", "room_id", r.id, "error", err)
	}
	stateCopy := state
	r.broadcast(Outbound{Type: "state", State: &stateCopy})
}

// dropGate abandons a pending start without releasing playback.
func (r *roomConn) dropGate() {
	if r.gate == nil {
		return
	}
	r.gate.timer.Stop()
	r.gate = nil
}

func (r *roomConn) broadcastWaiting() {
	if r.gate == nil {
		return
	}
	members := r.members()
	readiness := make([]MemberReadiness, 0, len(members))
	for _, member := range members {
		connected := r.clients[member.ID]
		readiness = append(readiness, MemberReadiness{
			MemberID:      member.ID,
			BufferAheadMs: connected.report.bufferAheadMs,
			Stalled:       connected.report.stalled,
			Ready:         r.clientReady(connected),
		})
	}
	r.broadcast(Outbound{Type: "waiting", TargetMs: r.gate.targetMs, Readiness: readiness})
}

// handleGatingToggle applies the controller's room-level gate setting. The
// gate holds every member, so a viewer's toggle is ignored just like a
// viewer's play would be.
func (r *roomConn) handleGatingToggle(sender *client, message Inbound) {
	if sender.id != r.controllerID || message.Enabled == nil {
		return
	}
	enabled := *message.Enabled
	ctx, cancel := context.WithTimeout(r.hub.ctx, storeTimeout)
	defer cancel()
	if err := r.hub.store.SetGatingDisabled(ctx, r.id, !enabled); err != nil {
		slog.ErrorContext(ctx, "persist gating setting failed", "room_id", r.id, "error", err)
		r.send(sender, Outbound{Type: "error", ErrCode: "internal_error"})
		return
	}
	r.gating = enabled
	r.broadcast(Outbound{Type: "gating", Gating: &enabled})
	// A pending start has nothing left to wait for once gating is off.
	if !enabled {
		r.releaseGate()
	}
}

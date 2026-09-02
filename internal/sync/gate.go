package sync

import (
	"context"
	"log/slog"
	"time"

	"github.com/giulianoo0/ss/internal/room"
)

const (
	GateReadyBufferMs   int64 = 3000
	GateMaxWait               = 20 * time.Second
	gatePositionSlackMs int64 = 2000
	stallRegateCooldown       = 20 * time.Second
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
	rate     float64
	timer    *time.Timer
}

// shouldGate reports whether a controller play or seek must wait for the room
// to buffer. The room is read fresh: the setting and the source can both
// change while this connection lives.
func (r *roomConn) shouldGate(ctx context.Context) bool {
	if len(r.clients) < 2 {
		return false
	}
	storedRoom, err := r.hub.store.Get(ctx, r.id)
	if err != nil {
		slog.ErrorContext(ctx, "load room for gate decision failed", "room_id", r.id, "error", err)
		return false
	}
	return storedRoom.GatingEnabled && storedRoom.SourceKind != room.SourceScreen
}

// openGate parks the room paused at targetMs and starts waiting for every
// member to buffer it. state must already carry the rate to resume with.
func (r *roomConn) openGate(ctx context.Context, sender *client, targetMs int64, state room.PlayState, now int64) {
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
	if _, ignored := r.ignored[connected.id]; ignored {
		return true
	}
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

func (r *roomConn) releaseGate() {
	gate := r.gate
	if gate == nil {
		return
	}
	r.gate = nil
	gate.timer.Stop()
	r.stallGateReadyAt = time.Now().Add(r.hub.stallCooldown)
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
		_, ignored := r.ignored[member.ID]
		readiness = append(readiness, MemberReadiness{
			MemberID:      member.ID,
			BufferAheadMs: connected.report.bufferAheadMs,
			Stalled:       connected.report.stalled,
			Ready:         r.clientReady(connected),
			Ignored:       ignored,
		})
	}
	r.broadcast(Outbound{Type: "waiting", TargetMs: r.gate.targetMs, Readiness: readiness})
}

// handleGatingToggle applies the controller's room-level gate setting; a
// viewer's toggle is ignored just like a viewer's play would be.
func (r *roomConn) handleGatingToggle(sender *client, message Inbound) {
	if sender.id != r.controllerID {
		r.send(sender, Outbound{Type: "error", ErrCode: "not_controller"})
		return
	}
	if message.Enabled == nil {
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
	if !enabled {
		r.releaseGate()
	}
}

// stalledMember names a connected member whose playback has run dry, or "" if
// everyone is keeping up. Ignored members never qualify: the room already
// decided not to wait for them.
func (r *roomConn) stalledMember() string {
	for id, connected := range r.clients {
		if _, ignored := r.ignored[id]; ignored {
			continue
		}
		if connected.report.received && connected.report.stalled {
			return id
		}
	}
	return ""
}

// gateOnStall stops the room when someone's playback runs dry mid-episode:
// the same gate as a play or a seek, opened at wherever the room is now.
func (r *roomConn) gateOnStall(ctx context.Context, now int64) {
	if r.gate != nil || !r.gating || len(r.clients) < 2 {
		return
	}
	if !r.stallGateReadyAt.IsZero() && time.Now().Before(r.stallGateReadyAt) {
		return
	}
	if r.stalledMember() == "" {
		return
	}

	state, err := r.hub.store.GetState(ctx, r.id)
	if err != nil {
		slog.ErrorContext(ctx, "load state for stall gate failed", "room_id", r.id, "error", err)
		return
	}
	if !state.Playing {
		return
	}
	slog.InfoContext(ctx, "room stopped for a stalled viewer", "room_id", r.id)
	r.openGate(ctx, nil, ExpectedPositionMs(state, now), state, now)
}

// handleIgnore drops a member from everything the room waits for. It is the
// controller's escape hatch: one person on a hopeless connection would
// otherwise hold the room still indefinitely.
func (r *roomConn) handleIgnore(sender *client, message Inbound) {
	if sender.id != r.controllerID || message.TargetID == "" {
		return
	}
	if message.TargetID == r.controllerID {
		return
	}
	if _, connected := r.clients[message.TargetID]; !connected {
		return
	}
	if r.ignored == nil {
		r.ignored = make(map[string]struct{})
	}
	r.ignored[message.TargetID] = struct{}{}
	slog.Info("member ignored for synchronized playback", "room_id", r.id, "member_id", message.TargetID)

	if !r.evaluateGate() {
		r.broadcastWaiting()
	}
}

package sync

import (
	"context"
	"fmt"
	"log/slog"
	"slices"
	"time"

	"github.com/giulianoo0/ss/internal/room"
)

// A guest who wants to put something on — a file, their screen, a live —
// asks the host; a yes is a grant kept here for stageGrantTTL or until the
// stage it was for is opened. The host never asks, and whoever opened a
// stage keeps running it without a grant.

// stageGrantTTL is how long a yes waits to be used. A variable so tests
// can shrink it.
var stageGrantTTL = 10 * time.Minute

// maxStageRequests caps the questions a room keeps open for its host.
const maxStageRequests = 16

type stageGrantKey struct {
	memberID string
	kind     string
}

type stageRequest struct {
	id       string
	memberID string
	nickname string
	kind     string
}

// OnStageClose registers what closing the media or the live does on the
// server: cancelling its production and clearing it from the room. Set
// once at startup; it runs off the room's goroutine.
func (h *Hub) OnStageClose(fn func(roomID, kind string)) {
	h.onStageClose = fn
}

// AuthorizeStage is the one rule for opening or running a stage over HTTP:
// a connected member who is the host, the stage's owner, or holds a grant
// for its kind. consume spends the grant, which is what opening a stage
// does; checking ahead of that (a publish token before the screen starts)
// leaves it.
func (h *Hub) AuthorizeStage(r *room.Room, memberID, capability, kind string, consume bool) bool {
	if r == nil || !h.AuthorizeMember(r.ID, memberID, capability) {
		return false
	}
	if r.ControllerID == memberID || ownsStage(r, memberID, kind) {
		return true
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	key := stageGrantKey{memberID: memberID, kind: kind}
	until, ok := h.grants[r.ID][key]
	if !ok {
		return false
	}
	if !time.Now().Before(until) {
		delete(h.grants[r.ID], key)
		return false
	}
	if consume {
		delete(h.grants[r.ID], key)
	}
	return true
}

func ownsStage(r *room.Room, memberID, kind string) bool {
	switch kind {
	case room.StageMedia:
		return r.SourceMemberID != "" && r.SourceMemberID == memberID
	case room.StageLive:
		return r.Live != nil && r.Live.MemberID != "" && r.Live.MemberID == memberID
	case room.StageScreen:
		return slices.ContainsFunc(r.Screens, func(share room.ScreenShare) bool { return share.MemberID == memberID })
	}
	return false
}

func validStageKind(kind string) bool {
	return kind == room.StageMedia || kind == room.StageLive || kind == room.StageScreen
}

func (h *Hub) grantStage(roomID, memberID, kind string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.grants[roomID] == nil {
		h.grants[roomID] = make(map[stageGrantKey]time.Time)
	}
	h.grants[roomID][stageGrantKey{memberID: memberID, kind: kind}] = time.Now().Add(stageGrantTTL)
}

func (h *Hub) dropGrants(roomID, memberID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for key := range h.grants[roomID] {
		if key.memberID == memberID {
			delete(h.grants[roomID], key)
		}
	}
}

func (r *roomConn) handleStageRequest(sender *client, message Inbound) {
	if !validStageKind(message.Kind) {
		r.send(sender, Outbound{Type: "error", ErrCode: "invalid_stage"})
		return
	}
	if sender.id == r.controllerID {
		return
	}
	for _, pending := range r.stageRequests {
		if pending.memberID == sender.id && pending.kind == message.Kind {
			return
		}
	}
	if len(r.stageRequests) >= maxStageRequests {
		r.send(sender, Outbound{Type: "error", ErrCode: "too_many_requests"})
		return
	}
	r.nextRequest++
	request := &stageRequest{
		id: fmt.Sprintf("q%d", r.nextRequest), memberID: sender.id,
		nickname: sender.member.Nickname, kind: message.Kind,
	}
	r.stageRequests = append(r.stageRequests, request)
	r.send(r.clients[r.controllerID], request.outbound())
	r.touch()
}

func (q *stageRequest) outbound() Outbound {
	return Outbound{Type: "stageRequest", RequestID: q.id, MemberID: q.memberID, Nickname: q.nickname, Kind: q.kind}
}

// replayStageRequests hands the open questions to whoever is host now.
func (r *roomConn) replayStageRequests() {
	host := r.clients[r.controllerID]
	for _, pending := range r.stageRequests {
		if pending.memberID != r.controllerID {
			r.send(host, pending.outbound())
		}
	}
}

func (r *roomConn) handleStageAnswer(sender *client, message Inbound) {
	if sender.id != r.controllerID {
		r.send(sender, Outbound{Type: "error", ErrCode: "not_controller"})
		return
	}
	index := slices.IndexFunc(r.stageRequests, func(q *stageRequest) bool { return q.id == message.RequestID })
	if index < 0 {
		return
	}
	request := r.stageRequests[index]
	r.stageRequests = slices.Delete(r.stageRequests, index, index+1)
	if message.Allow {
		r.hub.grantStage(r.id, request.memberID, request.kind)
	}
	allow := message.Allow
	r.send(r.clients[request.memberID], Outbound{Type: "stageGrant", Kind: request.kind, Allow: &allow})
	r.touch()
}

// forgetStageRequests drops what a member who left had asked for or been
// given.
func (r *roomConn) forgetStageRequests(memberID string) {
	r.stageRequests = slices.DeleteFunc(r.stageRequests, func(q *stageRequest) bool { return q.memberID == memberID })
	r.hub.dropGrants(r.id, memberID)
}

// handleStageClose takes a stage down. A screen ends here; the media and
// the live have production behind them, which the server hook stops.
func (r *roomConn) handleStageClose(sender *client, message Inbound) {
	if !validStageKind(message.Kind) {
		r.send(sender, Outbound{Type: "error", ErrCode: "invalid_stage"})
		return
	}
	ctx, cancel := context.WithTimeout(r.hub.ctx, storeTimeout)
	defer cancel()
	stored, err := r.hub.store.Get(ctx, r.id)
	if err != nil {
		slog.ErrorContext(ctx, "load room for stage close failed", "room_id", r.id, "error", err)
		r.send(sender, Outbound{Type: "error", ErrCode: "internal_error"})
		return
	}
	owner := ""
	switch message.Kind {
	case room.StageScreen:
		owner = message.TargetID
		if owner == "" {
			owner = sender.id
		}
	case room.StageMedia:
		owner = stored.SourceMemberID
	case room.StageLive:
		if stored.Live != nil {
			owner = stored.Live.MemberID
		}
	}
	if sender.id != r.controllerID && (owner == "" || owner != sender.id) {
		r.send(sender, Outbound{Type: "error", ErrCode: "not_stage_owner"})
		return
	}
	if owner != "" && owner != sender.id {
		r.send(r.clients[owner], Outbound{Type: "stageClosed", Kind: message.Kind})
	}
	r.touch()
	if message.Kind != room.StageScreen {
		if r.hub.onStageClose != nil {
			roomID, kind := r.id, message.Kind
			go recovered("stage close", roomID, func() { r.hub.onStageClose(roomID, kind) })
		}
		return
	}
	stopped, err := r.hub.store.StopScreenShare(ctx, r.id, owner)
	if err != nil {
		slog.ErrorContext(ctx, "close screen share failed", "room_id", r.id, "member_id", owner, "error", err)
		r.send(sender, Outbound{Type: "error", ErrCode: "internal_error"})
		return
	}
	if stopped {
		r.broadcast(Outbound{Type: "roomUpdated"})
	}
}

func (r *roomConn) handleSpotlight(sender *client, message Inbound) {
	if sender.id != r.controllerID {
		r.send(sender, Outbound{Type: "error", ErrCode: "not_controller"})
		return
	}
	var spotlight *room.Spotlight
	switch message.Kind {
	case "":
	case room.StageMedia, room.StageLive:
		spotlight = &room.Spotlight{Kind: message.Kind}
	case room.StageScreen, room.StageMember:
		if !r.seated(message.TargetID) {
			r.send(sender, Outbound{Type: "error", ErrCode: "invalid_spotlight"})
			return
		}
		spotlight = &room.Spotlight{Kind: message.Kind, MemberID: message.TargetID}
	default:
		r.send(sender, Outbound{Type: "error", ErrCode: "invalid_spotlight"})
		return
	}
	ctx, cancel := context.WithTimeout(r.hub.ctx, storeTimeout)
	defer cancel()
	if err := r.hub.store.SetSpotlight(ctx, r.id, spotlight); err != nil {
		slog.ErrorContext(ctx, "set spotlight failed", "room_id", r.id, "error", err)
		r.send(sender, Outbound{Type: "error", ErrCode: "internal_error"})
		return
	}
	r.broadcast(Outbound{Type: "spotlight", Spotlight: spotlight})
	r.touch()
}

func (r *roomConn) seated(memberID string) bool {
	if memberID == "" {
		return false
	}
	if _, ok := r.clients[memberID]; ok {
		return true
	}
	_, ok := r.detached[memberID]
	return ok
}

// mayDrive reports whether a member may play, pause, seek or change the
// rate: the host, and whoever opened the media.
func (r *roomConn) mayDrive(ctx context.Context, sender *client) bool {
	if sender.id == r.controllerID {
		return true
	}
	stored, err := r.hub.store.Get(ctx, r.id)
	if err != nil {
		return false
	}
	return stored.SourceMemberID != "" && stored.SourceMemberID == sender.id
}

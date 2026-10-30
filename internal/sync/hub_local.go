package sync

import (
	"context"
	"log/slog"
	"slices"

	"github.com/giulianoo0/ss/internal/room"
)

// A source can live in the desktop app of the member who opened it, which
// plays it from its own cache and fills the bucket only while someone else
// needs it: a browser, or an app that cannot open the source itself. Any
// other app opens the same torrent or video on its own and plays its own
// copy. The room asks that producer for the media with needBrowserMedia and
// lets it go with browserMediaIdle; until the bucket holds something, those
// waiting on it wait on their own and hold no one back.

// ClientDesktop on a hello is the desktop app; the room lists the member
// with it, and a browser with nothing.
const ClientDesktop = "desktop"

func clientKind(hello Inbound) string {
	if hello.Client == ClientDesktop {
		return ClientDesktop
	}
	return ""
}

// featureLocalSource on a hello is a client able to play a local source it
// opened from its own cache.
const featureLocalSource = "localSource"

// roomMedia is what the room goroutine knows of the media stage, read from
// the store when the room starts and again whenever the media's status moves.
type roomMedia struct {
	// local: the source is in the producer's app.
	local bool
	// bare: and the bucket has nothing the others can play yet.
	bare       bool
	generation int
	// producer: the member whose app opened the source.
	producer string
}

func mediaOf(r *room.Room) roomMedia {
	if r == nil || !r.LocalSource {
		return roomMedia{}
	}
	switch r.Status {
	case room.StatusLocal, room.StatusUploading:
		return roomMedia{local: true, bare: true, generation: r.MediaGeneration, producer: r.SourceMemberID}
	case room.StatusReady:
		return roomMedia{local: true, generation: r.MediaGeneration, producer: r.SourceMemberID}
	}
	return roomMedia{}
}

// featureLocalCopy on a hello is an app that opens a local source someone
// else shared on its own, from the room's localCopy.
const featureLocalCopy = "localCopy"

func playsLocally(hello Inbound) bool {
	return slices.Contains(hello.Features, featureLocalSource)
}

func copiesLocally(hello Inbound) bool {
	return hello.Client == ClientDesktop && slices.Contains(hello.Features, featureLocalCopy)
}

// refreshMedia rereads the media stage after its status moved.
func (r *roomConn) refreshMedia(ctx context.Context) {
	stored, err := r.hub.store.Get(ctx, r.id)
	if err != nil {
		slog.ErrorContext(ctx, "load room media for the hub failed", "room_id", r.id, "error", err)
		return
	}
	r.media = mediaOf(stored)
	r.syncBrowserMedia(nil)
}

// produces reports whether the member is the app playing the local source
// from its own cache; everyone else plays the bucket.
func (r *roomConn) produces(member *client) bool {
	return r.media.local && member.localSource && member.id == r.media.producer
}

// copies reports whether the member is an app playing its own copy of the
// local source someone else opened.
func (r *roomConn) copies(member *client) bool {
	return r.media.local && member.localCopy && member.copyFailed != r.media.generation &&
		member.id != r.media.producer
}

// waitsFor reports whether the room holds its playback for this member: one
// with no media to load yet is not waited on.
func (r *roomConn) waitsFor(member *client) bool {
	return !r.media.bare || r.produces(member) || r.copies(member)
}

func (r *roomConn) needsBucket() bool {
	return slices.ContainsFunc(r.seats(), func(seat *client) bool { return !r.produces(seat) && !r.copies(seat) })
}

// handleLocalCopyFailed moves an app that could not open the room's source
// to the bucket, asking the producer for it if no one else had.
func (r *roomConn) handleLocalCopyFailed(sender *client, message Inbound) {
	if !r.copies(sender) || message.Generation != r.media.generation {
		return
	}
	sender.copyFailed = message.Generation
	slog.Info("app could not open the room's source itself", "room_id", r.id, "member_id", sender.id,
		"generation", message.Generation)
	r.syncBrowserMedia(nil)
	if r.gate != nil && !r.evaluateGate() {
		r.broadcastWaiting()
	}
}

// syncBrowserMedia tells the producer whether someone needs the media in the
// bucket now: once when the first of them arrives or the generation changes,
// and once more when the last one leaves. greet is a member that just took
// its seat, told again what is already being asked of it if it produces.
func (r *roomConn) syncBrowserMedia(greet *client) {
	producer := r.clients[r.media.producer]
	want := r.media.local && r.needsBucket()
	switch {
	case want && r.browserAsked != r.media.generation:
		r.browserAsked = r.media.generation
		r.send(producer, Outbound{Type: "needBrowserMedia", Generation: r.browserAsked})
		return
	case !want && r.browserAsked != 0:
		r.browserAsked = 0
		r.send(producer, Outbound{Type: "browserMediaIdle"})
		return
	}
	if greet != nil && greet == producer && r.browserAsked != 0 {
		r.send(producer, Outbound{Type: "needBrowserMedia", Generation: r.browserAsked})
	}
}

// producedEdgeSlackMs is how far short of the edge of the uploaded media a
// viewer may run dry and still be at it: the room's clock and the viewer's
// player are never exactly together.
const producedEdgeSlackMs int64 = 3000

// pauseAtProducedEdge stops the room where its media ends for good: the app
// that produced it left before uploading the rest, so a viewer running dry at
// the edge of what is in the bucket would wait for nothing. It reports
// whether it paused.
func (r *roomConn) pauseAtProducedEdge(ctx context.Context, now int64) bool {
	if !r.media.local || r.clients[r.media.producer] != nil || !r.anyRunningDry() {
		return false
	}
	state, err := r.hub.store.GetState(ctx, r.id)
	if err != nil {
		slog.ErrorContext(ctx, "load state for the produced edge failed", "room_id", r.id, "error", err)
		return false
	}
	if !state.Playing {
		return false
	}
	stored, err := r.hub.store.Get(ctx, r.id)
	if err != nil {
		slog.ErrorContext(ctx, "load regions for the produced edge failed", "room_id", r.id, "error", err)
		return false
	}
	positionMs := ExpectedPositionMs(state, now)
	edge := producedEdge(stored.MediaRegions, positionMs)
	if positionMs < edge-producedEdgeSlackMs {
		return false
	}
	state.Playing = false
	state.PositionMs = min(positionMs, edge)
	state.ServerTimeMs = now
	if err := r.hub.store.SetState(ctx, r.id, state); err != nil {
		slog.ErrorContext(ctx, "persist the produced edge failed", "room_id", r.id, "error", err)
		return false
	}
	slog.InfoContext(ctx, "room paused where the producer left off", "room_id", r.id, "position_ms", state.PositionMs)
	r.playing = false
	r.broadcast(Outbound{Type: "state", State: &state})
	r.broadcast(Outbound{Type: "error", ErrCode: "producer_left"})
	return true
}

func (r *roomConn) anyRunningDry() bool {
	for _, connected := range r.clients {
		if connected.report.received && connected.report.runningDry() {
			return true
		}
	}
	return false
}

// producedEdge is where the media that holds a position ends: the end of the
// latest region starting at or before it, or the position itself when none
// does.
func producedEdge(regions []room.MediaRegion, positionMs int64) int64 {
	edge := positionMs
	var start int64 = -1
	for _, region := range regions {
		if region.StartMs <= positionMs && region.StartMs > start {
			start = region.StartMs
			edge = region.StartMs + region.ProducedMs
		}
	}
	return edge
}

package sync

import (
	"context"
	"log/slog"
	"slices"

	"github.com/giulianoo0/ss/internal/room"
)

// A source can live in the desktop app of the member who opened it, which
// plays it from its own cache and fills the bucket only while someone else is
// in the room: a browser or another app, both play the bucket. The room asks
// that producer for the media with needBrowserMedia and lets it go with
// browserMediaIdle; until the bucket holds something, everyone else waits on
// their own and holds no one back.

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

func playsLocally(hello Inbound) bool {
	return slices.Contains(hello.Features, featureLocalSource)
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

// waitsFor reports whether the room holds its playback for this member: one
// with no media to load yet is not waited on.
func (r *roomConn) waitsFor(member *client) bool {
	return !r.media.bare || r.produces(member)
}

func (r *roomConn) needsBucket() bool {
	return slices.ContainsFunc(r.seats(), func(seat *client) bool { return !r.produces(seat) })
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

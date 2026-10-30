package sync

import (
	"context"
	"log/slog"
	"slices"

	"github.com/giulianoo0/ss/internal/room"
)

// A source can live in the host's desktop app, which plays it from its own
// cache and fills the bucket only while someone in the room is on a browser.
// The room asks the host for that media with needBrowserMedia and lets it go
// with browserMediaIdle; until the bucket holds something, a browser waits
// on its own and holds no one else back.

// featureLocalSource on a hello is a client that plays a local source from
// its own cache.
const featureLocalSource = "localSource"

// roomMedia is what the room goroutine knows of the media stage, read from
// the store when the room starts and again whenever the media's status moves.
type roomMedia struct {
	// local: the source is in the host's app.
	local bool
	// bare: and the bucket has nothing a browser can play yet.
	bare       bool
	generation int
}

func mediaOf(r *room.Room) roomMedia {
	if r == nil || !r.LocalSource {
		return roomMedia{}
	}
	switch r.Status {
	case room.StatusLocal, room.StatusUploading:
		return roomMedia{local: true, bare: true, generation: r.MediaGeneration}
	case room.StatusReady:
		return roomMedia{local: true, generation: r.MediaGeneration}
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

// waitsFor reports whether the room holds its playback for this member: a
// browser with no media to load yet is not waited on.
func (r *roomConn) waitsFor(member *client) bool {
	return !r.media.bare || member.localSource
}

func (r *roomConn) hasBrowser() bool {
	return slices.ContainsFunc(r.seats(), func(seat *client) bool { return !seat.localSource })
}

// syncBrowserMedia tells the host whether a browser needs the media now: once
// when the first browser arrives or the generation changes, and once more when
// the last browser leaves. greet is a host that just took its seat or the
// controls, who is told again what is already being asked of it.
func (r *roomConn) syncBrowserMedia(greet *client) {
	host := r.clients[r.controllerID]
	want := r.media.local && r.hasBrowser()
	switch {
	case want && r.browserAsked != r.media.generation:
		r.browserAsked = r.media.generation
		r.send(host, Outbound{Type: "needBrowserMedia", Generation: r.browserAsked})
		return
	case !want && r.browserAsked != 0:
		r.browserAsked = 0
		r.send(host, Outbound{Type: "browserMediaIdle"})
		return
	}
	if greet != nil && greet == host && r.browserAsked != 0 {
		r.send(host, Outbound{Type: "needBrowserMedia", Generation: r.browserAsked})
	}
}

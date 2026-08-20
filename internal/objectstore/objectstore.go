// Package objectstore publishes room media to an S3-compatible bucket.
//
// Media used to be served from the application's own disk, which capped how
// many rooms could exist at once and tied every room to the machine that
// encoded it. Objects live in the bucket instead, are delivered straight from
// the edge, and expire through the bucket's own lifecycle rules.
package objectstore

import (
	"context"
	"errors"
	"io"
)

// Store writes and reclaims objects. Reads are the edge's job: nothing in the
// application ever fetches media back.
type Store interface {
	// Put stores size bytes under key. contentType and cacheControl are
	// recorded on the object, so delivery carries them without the
	// application being in the request path.
	Put(ctx context.Context, key string, r io.Reader, size int64, contentType, cacheControl string) error
	// RemovePrefix deletes every object under prefix. The bucket's lifecycle
	// rule is the backstop; this is what reclaims a room's media as soon as
	// the room itself is gone, rather than a day later.
	RemovePrefix(ctx context.Context, prefix string) error
}

// ErrEmptyPrefix is returned rather than deleting every object in the bucket.
var ErrEmptyPrefix = errors.New("objectstore: refusing to remove an empty prefix")

// RoomPrefix is where everything one room ever published lives, across every
// generation of its source.
//
// The trailing separator is load-bearing: without it the prefix also reaches
// rooms whose id merely starts with this one's.
func RoomPrefix(roomID string) string {
	return "rooms/" + roomID + "/"
}

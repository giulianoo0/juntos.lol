// Package objectstore publishes room media to an S3-compatible bucket.
// Objects are delivered straight from the edge and expire through the
// bucket's own lifecycle rules; the application never reads them back.
package objectstore

import (
	"context"
	"errors"
	"io"
)

// Store writes and reclaims objects. Reads are the edge's job: nothing in the
// application ever fetches media back.
type Store interface {
	Put(ctx context.Context, key string, r io.Reader, size int64, contentType, cacheControl string) error
	RemovePrefix(ctx context.Context, prefix string) error
}

var ErrEmptyPrefix = errors.New("objectstore: refusing to remove an empty prefix")

// RoomPrefix is where everything one room ever published lives, across every
// generation of its source. The trailing separator is load-bearing: without
// it the prefix also reaches rooms whose id merely starts with this one's.
func RoomPrefix(roomID string) string {
	return "rooms/" + roomID + "/"
}

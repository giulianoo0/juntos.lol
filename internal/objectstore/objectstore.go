// Package objectstore publishes room media to an S3-compatible bucket.
//
// Media used to be served from the application's own disk, which capped how
// many rooms could exist at once and tied every room to the machine that
// encoded it. Objects live in the bucket instead, are delivered straight from
// the edge, and expire through the bucket's own lifecycle rules.
package objectstore

import (
	"context"
	"io"
)

// Store writes objects. Reads are the edge's job: nothing in the application
// ever fetches media back.
type Store interface {
	// Put stores size bytes under key. contentType and cacheControl are
	// recorded on the object, so delivery carries them without the
	// application being in the request path.
	Put(ctx context.Context, key string, r io.Reader, size int64, contentType, cacheControl string) error
}

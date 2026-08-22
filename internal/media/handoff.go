package media

import (
	"context"
	"log/slog"
	"time"
)

const (
	// previewHandoffTimeout bounds how long a completed upload waits for its
	// preview to drain before the final encode is forced through anyway. The
	// drain is ordinarily seconds — the tail of a file the encoder was
	// already ahead of — so reaching this bound means the preview is wedged.
	previewHandoffTimeout = 10 * time.Minute
	// previewHandoffGrace is how long a forced cancellation is given to
	// actually wind the preview down before the final pass starts regardless.
	previewHandoffGrace = 30 * time.Second
)

// SubmitAfterPreview hands a completed upload to the final queue only once
// the room's preview job has fully wound down, publisher and subtitles
// included. The two passes write disjoint files into the same directory, but
// only their file names are disjoint — the master playlist, the published
// set in Redis and the finalize step are all last-writer-wins, and the final
// pass must be that last writer. Serializing here is what makes it one.
//
// It blocks, so callers run it in a goroutine.
func SubmitAfterPreview(ctx context.Context, progressive *Progressive, queue *Queue, roomID string) {
	select {
	case <-progressive.Done(roomID):
	case <-ctx.Done():
		return
	case <-time.After(previewHandoffTimeout):
		// A preview that cannot finish must not hold the room's real encode
		// hostage; from here it is treated as wedged and cut loose.
		slog.WarnContext(ctx, "preview drain timed out; forcing handoff", "room_id", roomID)
		progressive.Cancel(roomID)
		select {
		case <-progressive.Done(roomID):
		case <-ctx.Done():
			return
		case <-time.After(previewHandoffGrace):
			slog.ErrorContext(ctx, "preview refused to die; final encode starts anyway", "room_id", roomID)
		}
	}
	queue.Submit(roomID)
}

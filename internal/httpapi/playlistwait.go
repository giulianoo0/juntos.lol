package httpapi

import (
	"context"
	"strconv"
	"strings"
	"sync"
	"time"
)

// blockingReloadMax bounds how long a playlist request may hang waiting for the
// next publish; it only matters for a host that went quiet.
const blockingReloadMax = 10 * time.Second

// playlistWaiter holds a CAN-BLOCK-RELOAD request until the publish that grows
// the playlist to the sequence number the player asked for: one channel per
// room, closed and replaced on every publish.
type playlistWaiter struct {
	mu    sync.Mutex
	rooms map[string]chan struct{}
}

func newPlaylistWaiter() *playlistWaiter {
	return &playlistWaiter{rooms: make(map[string]chan struct{})}
}

// channel is what the next publish of this room closes.
func (w *playlistWaiter) channel(roomID string) chan struct{} {
	if w == nil {
		return nil
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	ch, ok := w.rooms[roomID]
	if !ok {
		ch = make(chan struct{})
		w.rooms[roomID] = ch
	}
	return ch
}

// Notify wakes every request waiting on this room's playlists.
func (w *playlistWaiter) Notify(roomID string) {
	if w == nil {
		return
	}
	w.mu.Lock()
	ch, ok := w.rooms[roomID]
	if ok {
		delete(w.rooms, roomID)
	}
	w.mu.Unlock()
	if ok {
		close(ch)
	}
}

// wait reports whether a publish (the channel closing) arrived before the deadline
// or the request went away.
func (w *playlistWaiter) wait(ctx context.Context, ch <-chan struct{}, deadline time.Time) bool {
	if w == nil || ch == nil {
		return false
	}
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return false
	}
	timer := time.NewTimer(remaining)
	defer timer.Stop()
	select {
	case <-ch:
		return true
	case <-timer.C:
		return false
	case <-ctx.Done():
		return false
	}
}

// requestedSequence reads the _HLS_msn directive: the media sequence number the
// player wants the playlist to reach.
func requestedSequence(query string) (int64, bool) {
	for _, pair := range strings.Split(query, "&") {
		key, value, found := strings.Cut(pair, "=")
		if !found || key != "_HLS_msn" {
			continue
		}
		msn, err := strconv.ParseInt(value, 10, 64)
		if err != nil || msn < 0 {
			return 0, false
		}
		return msn, true
	}
	return 0, false
}

// playlistReach returns the sequence number of the playlist's last segment and
// whether it ended; a master, or a playlist with no segment, reaches -1.
func playlistReach(playlist string) (lastSequence int64, ended bool) {
	var first int64
	var segments int64
	for _, line := range strings.Split(playlist, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "#EXT-X-MEDIA-SEQUENCE:"):
			first, _ = strconv.ParseInt(strings.TrimPrefix(line, "#EXT-X-MEDIA-SEQUENCE:"), 10, 64)
		case strings.HasPrefix(line, "#EXTINF:"):
			segments++
		case line == "#EXT-X-ENDLIST":
			ended = true
		}
	}
	return first + segments - 1, ended
}

// withBlockingReload injects the CAN-BLOCK-RELOAD tag; it describes this server,
// so it is never accepted from the host.
func withBlockingReload(playlist string) string {
	if !strings.Contains(playlist, "#EXTINF:") || strings.Contains(playlist, "#EXT-X-ENDLIST") ||
		strings.Contains(playlist, "#EXT-X-SERVER-CONTROL") {
		return playlist
	}
	const target = "#EXT-X-TARGETDURATION:"
	index := strings.Index(playlist, target)
	if index < 0 {
		return playlist
	}
	end := strings.Index(playlist[index:], "\n")
	if end < 0 {
		return playlist
	}
	cut := index + end + 1
	return playlist[:cut] + "#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES\n" + playlist[cut:]
}

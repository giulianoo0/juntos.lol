package sync

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// A room with people in it but nothing happening is usually a tab somebody
// forgot, holding a torrent and a bucket's worth of segments for an audience
// of nobody. It is asked before it is closed, because the alternative is
// closing a room on people who were arguing about what to watch next.

func roomAt(quietFor time.Duration, members int) *roomConn {
	r := &roomConn{
		id:           "r1",
		clients:      map[string]*client{},
		lastActivity: time.Now().Add(-quietFor),
		updates:      make(chan Outbound, 8),
	}
	for i := 0; i < members; i++ {
		r.clients[string(rune('a'+i))] = &client{send: make(chan Outbound, 8)}
	}
	return r
}

func TestAQuietRoomIsAskedBeforeItIsClosed(t *testing.T) {
	r := roomAt(idleAsk+time.Second, 1)

	require.False(t, r.sweepIdle(), "asking is not closing")
	require.True(t, r.asked)
}

func TestTheQuestionIsPutOnlyOnce(t *testing.T) {
	r := roomAt(idleAsk+time.Second, 1)
	require.False(t, r.sweepIdle())

	// A second tick a moment later must not ask again.
	before := len(r.clients["a"].send)
	require.False(t, r.sweepIdle())
	require.Equal(t, before, len(r.clients["a"].send))
}

func TestABusyRoomIsNeverAsked(t *testing.T) {
	r := roomAt(time.Minute, 2)

	require.False(t, r.sweepIdle())
	require.False(t, r.asked)
}

func TestAnEmptyRoomIsLeftToTheReclaimTimer(t *testing.T) {
	// It runs on a much shorter fuse and has nobody to ask.
	r := roomAt(idleClose+time.Hour, 0)

	require.False(t, r.sweepIdle())
	require.False(t, r.asked)
}

func TestAnsweringTakesTheQuestionBack(t *testing.T) {
	r := roomAt(idleAsk+time.Second, 1)
	require.False(t, r.sweepIdle())
	require.True(t, r.asked)

	r.touch()

	require.False(t, r.asked)
	// And the room is no longer near its deadline.
	require.False(t, r.sweepIdle())
	require.False(t, r.asked)
}

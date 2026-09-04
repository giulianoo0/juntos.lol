package sync

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

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
	require.False(t, r.sweepIdle())
	require.False(t, r.asked)
}

func TestAPlayingRoomIsNeverAskedAndItsClockRestarts(t *testing.T) {
	r := roomAt(idleClose+time.Hour, 1)
	r.playing = true

	require.False(t, r.sweepIdle())
	require.False(t, r.asked)
	require.Less(t, time.Since(r.lastActivity), time.Second)

	r.playing = false
	require.False(t, r.sweepIdle())
	require.False(t, r.asked)
}

func TestPlayTakesBackAnOutstandingQuestion(t *testing.T) {
	r := roomAt(idleAsk+time.Second, 1)
	require.False(t, r.sweepIdle())
	require.True(t, r.asked)

	r.playing = true
	require.False(t, r.sweepIdle())
	require.False(t, r.asked)
}

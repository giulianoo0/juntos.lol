package sync

import (
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/config"
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

func TestAQuietRoomClosedForGoodTellsItsMembersAndLetsTheirSocketsGo(t *testing.T) {
	_, store, server := newHubTestServer(t, config.Config{})
	shrinkIdleClock(t)
	require.NoError(t, store.SetStatus(t.Context(), "r1", "ready"))
	member := dialHubWS(t, server)
	helloHubClient(t, member, "host", 1)

	var farewell Outbound
	for farewell.Type != "error" {
		farewell = readHubEvent(t, member)
	}
	require.Equal(t, "room_gone", farewell.ErrCode)
	var closed Outbound
	require.Error(t, member.ReadJSON(&closed))
	require.Eventually(t, func() bool {
		stacks := make([]byte, 1<<20)
		return !strings.Contains(string(stacks[:runtime.Stack(stacks, true)]), "(*client).readPump")
	}, time.Second, 10*time.Millisecond, "the member's read loop outlived its room")
}

// The expiry sweeper deletes a room people may still be in: they hear it is
// gone instead of watching a player whose playlists all turn 404.
func TestARoomRemovedElsewhereTellsItsMembersItIsGone(t *testing.T) {
	hub, store, server := newHubTestServer(t, config.Config{})
	var reclaimed []string
	hub.OnRoomReclaimed(func(id string) { reclaimed = append(reclaimed, id) })
	member := dialHubWS(t, server)
	helloHubClient(t, member, "host", 1)
	require.NoError(t, store.Delete(t.Context(), "r1"))

	hub.RoomRemoved("r1")

	var farewell Outbound
	for farewell.Type != "error" {
		farewell = readHubEvent(t, member)
	}
	require.Equal(t, "room_gone", farewell.ErrCode)
	var closed Outbound
	require.Error(t, member.ReadJSON(&closed))
	require.Equal(t, []string{"r1"}, reclaimed, "the work the room started elsewhere goes with it")
}

func shrinkIdleClock(t *testing.T) {
	previousAsk, previousClose, previousTick := idleAsk, idleClose, idleTick
	idleAsk, idleClose, idleTick = 20*time.Millisecond, 40*time.Millisecond, 10*time.Millisecond
	t.Cleanup(func() { idleAsk, idleClose, idleTick = previousAsk, previousClose, previousTick })
}

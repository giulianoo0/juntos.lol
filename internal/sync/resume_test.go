package sync

import (
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
)

// holdSeats keeps dropped seats long enough for a test to come back to them.
func holdSeats(t *testing.T) {
	t.Helper()
	previous := resumeGrace
	resumeGrace = 5 * time.Second
	t.Cleanup(func() { resumeGrace = previous })
}

func resumeHubClient(t *testing.T, conn *websocket.Conn, nickname, memberID, capability string, clientTimeMs int64) Outbound {
	t.Helper()
	require.NoError(t, conn.WriteJSON(Inbound{
		Type: "hello", Nickname: nickname, ClientTimeMs: clientTimeMs, MemberID: memberID, Capability: capability,
	}))
	welcome := readHubEvent(t, conn)
	require.Equal(t, "welcome", welcome.Type)
	require.Equal(t, "pong", readHubEvent(t, conn).Type)
	return welcome
}

// requireNoEvent proves nothing was queued for conn: after a beat for the
// server to act, a heartbeat's pong must be the very next event. A read
// deadline would poison the connection, so a probe stands in for silence.
func requireNoEvent(t *testing.T, conn *websocket.Conn, within time.Duration) {
	t.Helper()
	time.Sleep(within)
	require.NoError(t, conn.WriteJSON(Inbound{Type: "heartbeat", ClientTimeMs: 777}))
	event := readHubEvent(t, conn)
	require.Equal(t, "pong", event.Type, "unexpected event %+v", event)
	require.Equal(t, int64(777), event.ClientTimeMs)
}

func TestHubResumeKeepsMemberAndScreen(t *testing.T) {
	hub, store, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	holdSeats(t)
	host := dialHubWS(t, server)
	helloHubClient(t, host, "host", 1)
	guest := dialHubWS(t, server)
	guestWelcome := helloHubClient(t, guest, "guest", 2)
	require.Equal(t, "members", readHubEvent(t, host).Type)
	require.NoError(t, store.StartScreenShare(t.Context(), "r1", room.ScreenShare{MemberID: "m2", Nickname: "guest", Since: time.Now().UTC()}, false))

	require.NoError(t, guest.Close())
	// The room holds the seat: nobody is told the guest left.
	requireNoEvent(t, host, 300*time.Millisecond)
	require.True(t, hub.AuthorizeMember("r1", "m2", guestWelcome.Capability))

	again := dialHubWS(t, server)
	welcome := resumeHubClient(t, again, "guest", "m2", guestWelcome.Capability, 3)
	require.Equal(t, "m2", welcome.MemberID)
	require.Equal(t, guestWelcome.Capability, welcome.Capability)
	require.Equal(t, "m1", welcome.ControllerID)
	require.Len(t, welcome.Members, 2)
	requireNoEvent(t, host, 300*time.Millisecond)

	stored, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Len(t, stored.Screens, 1)
	require.Equal(t, "m2", stored.Screens[0].MemberID)

	// The seat is live again: chat flows both ways under the same name.
	require.NoError(t, again.WriteJSON(Inbound{Type: "chat", Text: "back"}))
	chat := readHubEvent(t, host)
	require.Equal(t, "chat", chat.Type)
	require.Equal(t, "guest", chat.Message.Author)
	require.Equal(t, "chat", readHubEvent(t, again).Type)
}

func TestHubResumeKeepsTheControllerInControl(t *testing.T) {
	_, _, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	holdSeats(t)
	host := dialHubWS(t, server)
	hostWelcome := helloHubClient(t, host, "host", 1)
	guest := dialHubWS(t, server)
	helloHubClient(t, guest, "guest", 2)
	require.Equal(t, "members", readHubEvent(t, host).Type)

	require.NoError(t, host.Close())
	requireNoEvent(t, guest, 300*time.Millisecond)

	again := dialHubWS(t, server)
	welcome := resumeHubClient(t, again, "host", "m1", hostWelcome.Capability, 3)
	require.Equal(t, "m1", welcome.MemberID)
	require.Equal(t, "m1", welcome.ControllerID)
	require.NoError(t, again.WriteJSON(Inbound{Type: "play", PositionMs: 1000, Rate: 1}))
	require.Equal(t, "state", readHubEvent(t, guest).Type)
}

func TestHubResumeReplacesAHalfOpenSocket(t *testing.T) {
	_, _, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	holdSeats(t)
	host := dialHubWS(t, server)
	helloHubClient(t, host, "host", 1)
	guest := dialHubWS(t, server)
	guestWelcome := helloHubClient(t, guest, "guest", 2)
	require.Equal(t, "members", readHubEvent(t, host).Type)

	// The old socket is still open as far as the server knows.
	again := dialHubWS(t, server)
	welcome := resumeHubClient(t, again, "guest", "m2", guestWelcome.Capability, 3)
	require.Equal(t, "m2", welcome.MemberID)
	require.Len(t, welcome.Members, 2)
	requireNoEvent(t, host, 300*time.Millisecond)
	// The old socket is closed by the server, and its going does not count as leaving.
	require.NoError(t, guest.SetReadDeadline(time.Now().Add(time.Second)))
	var stale Outbound
	require.Error(t, guest.ReadJSON(&stale))
	requireNoEvent(t, host, 300*time.Millisecond)
	require.NoError(t, again.WriteJSON(Inbound{Type: "heartbeat", ClientTimeMs: 4}))
	require.Equal(t, "pong", readHubEvent(t, again).Type)
}

func TestHubResumeWithAWrongCapabilityIsAFreshJoin(t *testing.T) {
	_, _, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	holdSeats(t)
	host := dialHubWS(t, server)
	helloHubClient(t, host, "host", 1)
	again := dialHubWS(t, server)
	welcome := resumeHubClient(t, again, "guest", "m1", "forged", 2)
	require.Equal(t, "m2", welcome.MemberID)
	require.Equal(t, "m1", welcome.ControllerID)
}

func TestHubDetachedMemberLeavesAfterGrace(t *testing.T) {
	hub, store, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	host := dialHubWS(t, server)
	helloHubClient(t, host, "host", 1)
	guest := dialHubWS(t, server)
	guestWelcome := helloHubClient(t, guest, "guest", 2)
	require.Equal(t, "members", readHubEvent(t, host).Type)
	require.NoError(t, store.StartScreenShare(t.Context(), "r1", room.ScreenShare{MemberID: "m2", Nickname: "guest", Since: time.Now().UTC()}, false))

	require.NoError(t, guest.Close())
	require.Equal(t, "roomUpdated", readHubEvent(t, host).Type)
	members := readHubEvent(t, host)
	require.Equal(t, "members", members.Type)
	require.Len(t, members.Members, 1)
	require.False(t, hub.AuthorizeMember("r1", "m2", guestWelcome.Capability))

	stored, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Empty(t, stored.Screens)
}

func TestHubHeartbeatsKeepAConnectionWhosePongsAreLate(t *testing.T) {
	previousWait, previousPeriod := pongWait, pingPeriod
	pongWait, pingPeriod = 300*time.Millisecond, 100*time.Millisecond
	t.Cleanup(func() { pongWait, pingPeriod = previousWait, previousPeriod })
	_, _, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	host := dialHubWS(t, server)
	// A client that never answers pings, but keeps talking.
	host.SetPingHandler(func(string) error { return nil })
	helloHubClient(t, host, "host", 1)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		require.NoError(t, host.WriteJSON(Inbound{Type: "heartbeat", ClientTimeMs: 5}))
		require.Equal(t, "pong", readHubEvent(t, host).Type)
		time.Sleep(100 * time.Millisecond)
	}
}

package sync

import (
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
)

// dialFromIP connects from a given address, as the edge would report it.
func dialFromIP(t *testing.T, serverURL, ip string) *websocket.Conn {
	t.Helper()
	target, err := url.Parse(serverURL)
	require.NoError(t, err)
	target.Scheme = "ws"
	target.Path = "/ws/rooms/r1"
	conn, response, err := websocket.DefaultDialer.Dial(target.String(), http.Header{"X-Test-Ip": {ip}})
	if response != nil {
		defer response.Body.Close()
	}
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func helloFrom(t *testing.T, conn *websocket.Conn, hello Inbound) Outbound {
	t.Helper()
	hello.Type = "hello"
	require.NoError(t, conn.WriteJSON(hello))
	return readHubEvent(t, conn)
}

// kickGuest has the host put m2 out and reads what the host is told.
func kickGuest(t *testing.T, host, guest *websocket.Conn) {
	t.Helper()
	require.NoError(t, host.WriteJSON(Inbound{Type: "kick", TargetID: "m2"}))
	if guest != nil {
		require.Equal(t, "kicked", readHubEvent(t, guest).ErrCode)
	}
	require.Equal(t, "members", readHubEvent(t, host).Type)
	bans := readHubEvent(t, host)
	require.Equal(t, "bans", bans.Type)
	require.Equal(t, []BanView{{ID: "m2", Nickname: "guest"}}, bans.Bans)
}

func TestKickedSeatIsTurnedAwayWhenItReconnects(t *testing.T) {
	_, _, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	host := dialHubWS(t, server)
	helloHubClient(t, host, "host", 1)
	guest := dialHubWS(t, server)
	welcome := helloHubClient(t, guest, "guest", 2)
	require.Equal(t, "members", readHubEvent(t, host).Type)

	kickGuest(t, host, guest)

	again := dialHubWS(t, server)
	refused := helloFrom(t, again, Inbound{Nickname: "guest", MemberID: "m2", Capability: welcome.Capability})
	require.Equal(t, "kicked", refused.ErrCode)
	requireNoEvent(t, host, 100*time.Millisecond)
}

func TestKickMovesTheRoomOffTheRelayTheKickedKnows(t *testing.T) {
	hub, _, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	moved := make(chan string, 1)
	hub.OnKick(func(roomID string) { moved <- roomID })
	host := dialHubWS(t, server)
	helloHubClient(t, host, "host", 1)
	guest := dialHubWS(t, server)
	helloHubClient(t, guest, "guest", 2)
	require.Equal(t, "members", readHubEvent(t, host).Type)

	kickGuest(t, host, guest)

	select {
	case roomID := <-moved:
		require.Equal(t, "r1", roomID)
	case <-time.After(2 * time.Second):
		t.Fatal("a kick left the room on its relay")
	}
}

func TestKickReachesASeatHeldForADroppedSocket(t *testing.T) {
	holdSeats(t)
	_, _, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	host := dialHubWS(t, server)
	helloHubClient(t, host, "host", 1)
	guest := dialHubWS(t, server)
	welcome := helloHubClient(t, guest, "guest", 2)
	require.Equal(t, "members", readHubEvent(t, host).Type)
	require.NoError(t, guest.Close())
	requireNoEvent(t, host, 100*time.Millisecond)

	// The dropped tab never heard the kick; its reconnect hears it instead.
	kickGuest(t, host, nil)
	again := dialHubWS(t, server)
	refused := helloFrom(t, again, Inbound{Nickname: "guest", MemberID: "m2", Capability: welcome.Capability})
	require.Equal(t, "kicked", refused.ErrCode)
}

func TestKickedBrowserCannotJoinFreshUntilTheHostLetsItBack(t *testing.T) {
	_, _, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	host := dialHubWS(t, server)
	helloHubClient(t, host, "host", 1)
	guest := dialHubWS(t, server)
	require.Equal(t, "welcome", helloFrom(t, guest, Inbound{Nickname: "guest", Device: "browser-b-0123456789"}).Type)
	require.Equal(t, "pong", readHubEvent(t, guest).Type)
	require.Equal(t, "members", readHubEvent(t, host).Type)

	kickGuest(t, host, guest)

	// A reload or a new tab is a fresh hello from the same browser.
	again := dialHubWS(t, server)
	require.Equal(t, "kicked", helloFrom(t, again, Inbound{Nickname: "guest2", Device: "browser-b-0123456789"}).ErrCode)
	other := dialHubWS(t, server)
	require.Equal(t, "welcome", helloFrom(t, other, Inbound{Nickname: "someone", Device: "browser-c-0123456789"}).Type)
	require.Equal(t, "pong", readHubEvent(t, other).Type)
	require.Equal(t, "members", readHubEvent(t, host).Type)

	require.NoError(t, host.WriteJSON(Inbound{Type: "unban", TargetID: "m2"}))
	cleared := readHubEvent(t, host)
	require.Equal(t, "bans", cleared.Type)
	require.Empty(t, cleared.Bans)
	back := dialHubWS(t, server)
	require.Equal(t, "welcome", helloFrom(t, back, Inbound{Nickname: "guest", Device: "browser-b-0123456789"}).Type)
}

func TestKickedAddressCannotJoinButSeatsAlreadyInKeepReconnecting(t *testing.T) {
	holdSeats(t)
	hub, _, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	hub.SetClientIP(func(r *http.Request) string { return r.Header.Get("X-Test-Ip") })
	host := dialFromIP(t, server.URL, "198.51.100.1")
	helloHubClient(t, host, "host", 1)
	guest := dialFromIP(t, server.URL, "203.0.113.9")
	require.Equal(t, "welcome", helloFrom(t, guest, Inbound{Nickname: "guest", Device: "device-1-0123456789"}).Type)
	require.Equal(t, "pong", readHubEvent(t, guest).Type)
	require.Equal(t, "members", readHubEvent(t, host).Type)
	housemate := dialFromIP(t, server.URL, "203.0.113.9")
	mate := helloFrom(t, housemate, Inbound{Nickname: "mate", Device: "device-2-0123456789"})
	require.Equal(t, "welcome", mate.Type)
	require.Equal(t, "pong", readHubEvent(t, housemate).Type)
	require.Equal(t, "members", readHubEvent(t, host).Type)
	require.Equal(t, "members", readHubEvent(t, guest).Type)

	kickGuest(t, host, guest)

	// Incognito: a new browser, same address.
	incognito := dialFromIP(t, server.URL, "203.0.113.9")
	require.Equal(t, "kicked", helloFrom(t, incognito, Inbound{Nickname: "x", Device: "device-3-0123456789"}).ErrCode)

	// The housemate already in drops and comes back as themselves.
	require.NoError(t, housemate.Close())
	back := dialFromIP(t, server.URL, "203.0.113.9")
	resumed := helloFrom(t, back, Inbound{Nickname: "mate", Device: "device-2-0123456789", MemberID: mate.MemberID, Capability: mate.Capability})
	require.Equal(t, "welcome", resumed.Type)
	require.Equal(t, mate.MemberID, resumed.MemberID)
}

func TestKickedSeatIsNotLetIntoTheLobbyNorPastThePassword(t *testing.T) {
	for _, mode := range []string{room.JoinApproval, room.JoinPassword} {
		t.Run(mode, func(t *testing.T) {
			_, store, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
			host := dialHubWS(t, server)
			helloHubClient(t, host, "host", 1)
			guest := dialHubWS(t, server)
			require.Equal(t, "welcome", helloFrom(t, guest, Inbound{Nickname: "guest", Device: "device-1-0123456789"}).Type)
			require.Equal(t, "pong", readHubEvent(t, guest).Type)
			require.Equal(t, "members", readHubEvent(t, host).Type)
			require.NoError(t, store.SetAccess(t.Context(), "r1", room.Access{Mode: mode, PasswordHash: "x"}))

			kickGuest(t, host, guest)

			// Answered at the door: the host is not asked, the password not wanted.
			again := dialHubWS(t, server)
			require.Equal(t, "kicked", helloFrom(t, again, Inbound{Nickname: "guest", Device: "device-1-0123456789"}).ErrCode)
			requireNoEvent(t, host, 100*time.Millisecond)
		})
	}
}

func TestOnlyTheHostLetsSomeoneBack(t *testing.T) {
	_, _, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	host := dialHubWS(t, server)
	helloHubClient(t, host, "host", 1)
	guest := dialHubWS(t, server)
	require.Equal(t, "welcome", helloFrom(t, guest, Inbound{Nickname: "guest", Device: "device-1-0123456789"}).Type)
	require.Equal(t, "pong", readHubEvent(t, guest).Type)
	require.Equal(t, "members", readHubEvent(t, host).Type)
	other := dialHubWS(t, server)
	helloHubClient(t, other, "other", 3)
	require.Equal(t, "members", readHubEvent(t, host).Type)
	require.Equal(t, "members", readHubEvent(t, guest).Type)

	kickGuest(t, host, guest)
	require.Equal(t, "members", readHubEvent(t, other).Type)
	require.Equal(t, "bans", readHubEvent(t, other).Type)

	require.NoError(t, other.WriteJSON(Inbound{Type: "unban", TargetID: "m2"}))
	require.Equal(t, "not_controller", readHubEvent(t, other).ErrCode)
	again := dialHubWS(t, server)
	require.Equal(t, "kicked", helloFrom(t, again, Inbound{Nickname: "guest", Device: "device-1-0123456789"}).ErrCode)
}

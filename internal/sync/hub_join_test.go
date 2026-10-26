package sync

import (
	"net/url"
	stdsync "sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
)

const joinOwnerToken = "owner-token-of-the-host"

func newJoinRoom(t *testing.T, mode string) (*Hub, func(hello Inbound) (*websocket.Conn, Outbound)) {
	t.Helper()
	hub, store, server := newHubTestServer(t, config.Config{})
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "r2", Status: "ready", ControllerID: "m1", OwnerToken: joinOwnerToken,
		CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
	require.NoError(t, store.SetAccess(t.Context(), "r2", room.Access{Mode: mode, PasswordHash: "unused-here"}))
	hello := func(message Inbound) (*websocket.Conn, Outbound) {
		serverURL, err := url.Parse(server.URL)
		require.NoError(t, err)
		serverURL.Scheme = "ws"
		serverURL.Path = "/ws/rooms/r2"
		conn, response, err := websocket.DefaultDialer.Dial(serverURL.String(), nil)
		if response != nil {
			defer response.Body.Close()
		}
		require.NoError(t, err)
		t.Cleanup(func() { _ = conn.Close() })
		message.Type = "hello"
		require.NoError(t, conn.WriteJSON(message))
		return conn, readHubEvent(t, conn)
	}
	return hub, hello
}

func TestPasswordRoomNeedsATicket(t *testing.T) {
	hub, hello := newJoinRoom(t, room.JoinPassword)

	_, first := hello(Inbound{Nickname: "guest"})
	require.Equal(t, "error", first.Type)
	require.Equal(t, "password_required", first.ErrCode)

	_, forged := hello(Inbound{Nickname: "guest", Ticket: "forged"})
	require.Equal(t, "bad_ticket", forged.ErrCode)

	_, elsewhere := hello(Inbound{Nickname: "guest", Ticket: hub.MintTicket("r1")})
	require.Equal(t, "bad_ticket", elsewhere.ErrCode, "a ticket opens only the room it was cut for")

	_, welcome := hello(Inbound{Nickname: "guest", Ticket: hub.MintTicket("r2")})
	require.Equal(t, "welcome", welcome.Type)

	_, host := hello(Inbound{Nickname: "host", OwnerToken: joinOwnerToken})
	require.Equal(t, "welcome", host.Type, "the host walks straight in")
}

func TestTicketExpires(t *testing.T) {
	hub, hello := newJoinRoom(t, room.JoinPassword)
	previous := ticketTTL
	ticketTTL = -time.Second
	ticket := hub.MintTicket("r2")
	ticketTTL = previous
	_, stale := hello(Inbound{Nickname: "guest", Ticket: ticket})
	require.Equal(t, "bad_ticket", stale.ErrCode)
}

func TestApprovalRoomHoldsGuestsInTheLobby(t *testing.T) {
	_, hello := newJoinRoom(t, room.JoinApproval)
	host, welcome := hello(Inbound{Nickname: "host", OwnerToken: joinOwnerToken})
	require.Equal(t, "welcome", welcome.Type)
	readHubEvent(t, host)

	guest, lobby := hello(Inbound{Nickname: "guest"})
	require.Equal(t, "lobby", lobby.Type)
	knock := readHubEvent(t, host)
	require.Equal(t, "knock", knock.Type)
	require.Equal(t, "guest", knock.Nickname)
	require.NotEmpty(t, knock.RequestID)

	require.NoError(t, host.WriteJSON(Inbound{Type: "admit", TargetID: knock.RequestID}))
	require.Equal(t, "admitted", readHubEvent(t, guest).Type)
	require.Equal(t, "welcome", readHubEvent(t, guest).Type)
	require.Equal(t, "members", readHubEvent(t, host).Type)
}

func TestApprovalRoomTurnsDeniedGuestsAway(t *testing.T) {
	_, hello := newJoinRoom(t, room.JoinApproval)
	host, _ := hello(Inbound{Nickname: "host", OwnerToken: joinOwnerToken})
	readHubEvent(t, host)

	guest, _ := hello(Inbound{Nickname: "guest"})
	knock := readHubEvent(t, host)
	require.NoError(t, host.WriteJSON(Inbound{Type: "deny", TargetID: knock.RequestID}))
	require.Equal(t, "denied", readHubEvent(t, guest).Type)
	require.NoError(t, guest.SetReadDeadline(time.Now().Add(time.Second)))
	_, _, err := guest.ReadMessage()
	require.Error(t, err, "a denied guest's socket is closed")
}

func TestKnockWaitsForTheHost(t *testing.T) {
	_, hello := newJoinRoom(t, room.JoinApproval)
	guest, lobby := hello(Inbound{Nickname: "guest"})
	require.Equal(t, "lobby", lobby.Type)

	host, welcome := hello(Inbound{Nickname: "host", OwnerToken: joinOwnerToken})
	require.Equal(t, "welcome", welcome.Type)
	readHubEvent(t, host)
	knock := readHubEvent(t, host)
	require.Equal(t, "knock", knock.Type, "a host who arrives late still hears the knock")

	require.NoError(t, host.WriteJSON(Inbound{Type: "admit", TargetID: knock.RequestID}))
	require.Equal(t, "admitted", readHubEvent(t, guest).Type)
}

func TestOnlyTheHostAnswersAKnock(t *testing.T) {
	_, hello := newJoinRoom(t, room.JoinApproval)
	host, _ := hello(Inbound{Nickname: "host", OwnerToken: joinOwnerToken})
	readHubEvent(t, host)
	first, _ := hello(Inbound{Nickname: "first"})
	knock := readHubEvent(t, host)
	require.NoError(t, host.WriteJSON(Inbound{Type: "admit", TargetID: knock.RequestID}))
	require.Equal(t, "admitted", readHubEvent(t, first).Type)
	require.Equal(t, "welcome", readHubEvent(t, first).Type)
	require.Equal(t, "pong", readHubEvent(t, first).Type)
	readHubEvent(t, host)

	_, _ = hello(Inbound{Nickname: "second"})
	second := readHubEvent(t, host)
	require.Equal(t, "knock", second.Type)
	require.NoError(t, first.WriteJSON(Inbound{Type: "admit", TargetID: second.RequestID}))
	require.Equal(t, "not_controller", readHubEvent(t, first).ErrCode)

	require.NoError(t, host.WriteJSON(Inbound{Type: "admit", TargetID: "nope"}))
	require.Equal(t, "request_not_found", readHubEvent(t, host).ErrCode)
}

type recordedActivity struct {
	mu     stdsync.Mutex
	events []string
}

func (a *recordedActivity) add(event string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.events = append(a.events, event)
}
func (a *recordedActivity) HostJoined(roomID string)  { a.add("host:" + roomID) }
func (a *recordedActivity) RoomChanged(roomID string) { a.add("changed:" + roomID) }
func (a *recordedActivity) RoomClosed(roomID string)  { a.add("closed:" + roomID) }
func (a *recordedActivity) snapshot() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.events...)
}

func TestActivityFollowsTheRoom(t *testing.T) {
	hub, hello := newJoinRoom(t, room.JoinOpen)
	activity := &recordedActivity{}
	hub.SetActivityNotifier(activity)

	host, _ := hello(Inbound{Nickname: "host", OwnerToken: joinOwnerToken})
	readHubEvent(t, host)
	guest, _ := hello(Inbound{Nickname: "guest"})
	require.Eventually(t, func() bool { return len(activity.snapshot()) == 2 }, time.Second, 10*time.Millisecond)
	require.Equal(t, []string{"host:r2", "changed:r2"}, activity.snapshot())

	require.NoError(t, guest.Close())
	require.Eventually(t, func() bool { return len(activity.snapshot()) == 3 }, 2*time.Second, 10*time.Millisecond)
	require.Equal(t, "changed:r2", activity.snapshot()[2], "someone leaving changes the room")

	hub.NotifyRoomUpdated("r2")
	require.Eventually(t, func() bool { return len(activity.snapshot()) == 4 }, time.Second, 10*time.Millisecond)
}

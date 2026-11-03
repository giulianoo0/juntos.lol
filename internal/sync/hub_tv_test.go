package sync

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
)

// tvAccounts signs a socket in as the TV of account N when it carries
// ?tv=N, and otherwise the way cookieAccounts does.
type tvAccounts struct{ cookieAccounts }

func (a *tvAccounts) Identify(r *http.Request) (Identity, bool) {
	if token := r.URL.Query().Get("tv"); token != "" {
		id, _ := strconv.ParseInt(token, 10, 64)
		return Identity{AccountID: id, Nickname: "conta" + token, TV: true}, id > 0
	}
	return a.cookieAccounts.Identify(r)
}

func newTVHub(t *testing.T, cfg config.Config) (*Hub, *room.Store, *httptest.Server) {
	t.Helper()
	hub, store, server := newHubTestServer(t, cfg)
	hub.SetAccounts(&tvAccounts{})
	return hub, store, server
}

func dialTV(t *testing.T, server *httptest.Server, roomID string, accountID int64) *websocket.Conn {
	t.Helper()
	serverURL, err := url.Parse(server.URL)
	require.NoError(t, err)
	serverURL.Scheme = "ws"
	serverURL.Path = "/ws/rooms/" + roomID
	serverURL.RawQuery = "tv=" + strconv.FormatInt(accountID, 10)
	conn, response, err := websocket.DefaultDialer.Dial(serverURL.String(), nil)
	if response != nil {
		defer response.Body.Close()
	}
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func helloTV(t *testing.T, conn *websocket.Conn, extra Inbound) Outbound {
	t.Helper()
	extra.Type, extra.Nickname, extra.Client = "hello", "conta", ClientTV
	require.NoError(t, conn.WriteJSON(extra))
	return readHubEvent(t, conn)
}

func readUntil(t *testing.T, conn *websocket.Conn, kind string) Outbound {
	t.Helper()
	for {
		event := readHubEvent(t, conn)
		if event.Type == kind {
			return event
		}
	}
}

func TestTVStaysOutOfTheMemberListAndMarksItsOwner(t *testing.T) {
	_, _, server := newTVHub(t, config.Config{})
	ana := dialAs(t, server, 7)
	helloHubClient(t, ana, "ana", 1)

	tv := dialTV(t, server, "r1", 7)
	welcome := helloTV(t, tv, Inbound{})

	require.Equal(t, "welcome", welcome.Type)
	require.Len(t, welcome.Members, 1, "a TV não aparece como pessoa")
	require.True(t, welcome.Members[0].TV)
	seen := readUntil(t, ana, "members")
	require.Len(t, seen.Members, 1)
	require.True(t, seen.Members[0].TV, "a dona ganha a marca de TV")

	require.NoError(t, tv.Close())
	gone := readUntil(t, ana, "members")
	require.Len(t, gone.Members, 1)
	require.False(t, gone.Members[0].TV, "sem TV na sala, sem marca")
}

func TestHelloAsTVNeedsATVSignIn(t *testing.T) {
	_, _, server := newTVHub(t, config.Config{})
	plain := dialAs(t, server, 7)

	require.NoError(t, plain.WriteJSON(Inbound{Type: "hello", Nickname: "ana", Client: ClientTV}))

	refused := readHubEvent(t, plain)
	require.Equal(t, "error", refused.Type)
	require.Equal(t, "invalid_hello", refused.ErrCode)
}

func TestTVDoesNotCountTowardTheRoomLimit(t *testing.T) {
	_, _, server := newTVHub(t, config.Config{MaxParticipants: 1})
	ana := dialAs(t, server, 7)
	helloHubClient(t, ana, "ana", 1)

	welcome := helloTV(t, dialTV(t, server, "r1", 7), Inbound{})

	require.Equal(t, "welcome", welcome.Type)
}

func TestTVNeverTakesTheControls(t *testing.T) {
	_, _, server := newTVHub(t, config.Config{})
	tv := dialTV(t, server, "r1", 7)
	tvWelcome := helloTV(t, tv, Inbound{})
	require.NotEqual(t, tvWelcome.ControllerID, tvWelcome.MemberID, "a TV sozinha não vira host nem herda o id guardado")

	ana := dialAs(t, server, 7)
	welcome := helloHubClient(t, ana, "ana", 1)

	require.Equal(t, welcome.MemberID, welcome.ControllerID, "a primeira pessoa é a host, não a TV")
}

func TestTVIsNotPresenceOfItsAccount(t *testing.T) {
	hub, _, server := newTVHub(t, config.Config{})

	helloTV(t, dialTV(t, server, "r1", 7), Inbound{})

	require.Empty(t, hub.Presence([]int64{7}), "a conta não está na sala só porque a TV está")
}

func TestTVMessagesThatPublishAreDropped(t *testing.T) {
	enabled := true
	for _, message := range []Inbound{
		{Type: "media", Mic: &enabled},
		{Type: "stageRequest", Kind: room.StageScreen},
		{Type: "chat", Text: "oi"},
		{Type: "titleRequest", Title: &TitleRequest{MetaID: "tt1", MetaType: "movie", Name: "Filme"}},
	} {
		t.Run(message.Type, func(t *testing.T) {
			_, _, server := newTVHub(t, config.Config{})
			host := dialAs(t, server, 7)
			helloHubClient(t, host, "ana", 1)
			tv := dialTV(t, server, "r1", 9)
			helloTV(t, tv, Inbound{})
			readUntil(t, host, "members")

			require.NoError(t, tv.WriteJSON(message))
			require.NoError(t, tv.WriteJSON(Inbound{Type: "heartbeat", ClientTimeMs: 5}))
			for readUntil(t, tv, "pong").ClientTimeMs != 5 {
			}

			require.NoError(t, host.WriteJSON(Inbound{Type: "heartbeat", ClientTimeMs: 6}))
			next := readHubEvent(t, host)
			require.Equal(t, "pong", next.Type, "nada do que a TV mandou chegou à sala")
		})
	}
}

func TestRoomPlaysWithoutWaitingForTheTV(t *testing.T) {
	_, _, server := newTVHub(t, config.Config{})
	host := dialAs(t, server, 7)
	helloHubClient(t, host, "ana", 1)
	tv := dialTV(t, server, "r1", 7)
	helloTV(t, tv, Inbound{})

	require.NoError(t, host.WriteJSON(Inbound{Type: "play", PositionMs: 1000}))

	state := readUntil(t, tv, "state")
	require.True(t, state.State.Playing)
	require.Equal(t, int64(1000), state.State.PositionMs)
}

func TestApprovalRoomLetsInTheTVOfSomeoneSeated(t *testing.T) {
	_, store, server := newTVHub(t, config.Config{})
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "r2", Status: "ready", ControllerID: "m1", OwnerToken: joinOwnerToken,
		CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
	require.NoError(t, store.SetAccess(t.Context(), "r2", room.Access{Mode: room.JoinApproval}))
	serverURL, err := url.Parse(server.URL)
	require.NoError(t, err)
	serverURL.Scheme = "ws"
	serverURL.Path = "/ws/rooms/r2"
	host, response, err := websocket.DefaultDialer.Dial(serverURL.String(), http.Header{"Cookie": {"acct=7"}})
	require.NoError(t, err)
	response.Body.Close()
	t.Cleanup(func() { _ = host.Close() })
	require.NoError(t, host.WriteJSON(Inbound{Type: "hello", Nickname: "ana", OwnerToken: joinOwnerToken}))
	require.Equal(t, "welcome", readHubEvent(t, host).Type)

	seated := helloTV(t, dialTV(t, server, "r2", 7), Inbound{})
	stranger := helloTV(t, dialTV(t, server, "r2", 9), Inbound{})

	require.Equal(t, "welcome", seated.Type, "a TV de quem já está na sala entra direto")
	require.Equal(t, "lobby", stranger.Type, "a TV de quem não está espera como qualquer um")
}

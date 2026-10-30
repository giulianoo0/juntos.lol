package sync

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
)

// localRoom is a room whose media lives in the host's desktop app.
func localRoom(t *testing.T) (*Hub, *room.Store, *httptest.Server, int) {
	t.Helper()
	hub, store, server := newHubTestServer(t, config.Config{})
	_, generation, err := store.SwapSource(t.Context(), "r1", "m1", "Filme", room.StatusLocal, time.Now())
	require.NoError(t, err)
	return hub, store, server, generation
}

func helloApp(t *testing.T, conn *websocket.Conn, nickname string) Outbound {
	t.Helper()
	require.NoError(t, conn.WriteJSON(Inbound{
		Type: "hello", Nickname: nickname, ClientTimeMs: 1, Client: "desktop", Features: []string{"localSource"},
	}))
	welcome := readHubEvent(t, conn)
	require.Equal(t, "welcome", welcome.Type)
	require.Equal(t, "pong", readHubEvent(t, conn).Type)
	return welcome
}

// nextOf reads past everything else up to the first event of that type.
func nextOf(t *testing.T, conn *websocket.Conn, eventType string) Outbound {
	t.Helper()
	for {
		event := readHubEvent(t, conn)
		if event.Type == eventType {
			return event
		}
	}
}

func TestTheAppHostIsAskedForBrowserMediaWhileABrowserIsIn(t *testing.T) {
	_, _, server, generation := localRoom(t)
	host := dialHubWS(t, server)
	helloApp(t, host, "host")
	requireNoEvent(t, host, 50*time.Millisecond)

	guest := dialHubWS(t, server)
	helloHubClient(t, guest, "guest", 2)

	asked := nextOf(t, host, "needBrowserMedia")
	require.Equal(t, generation, asked.Generation)

	require.NoError(t, guest.Close())
	nextOf(t, host, "browserMediaIdle")
}

func clientOf(members []room.Member) map[string]string {
	out := map[string]string{}
	for _, member := range members {
		out[member.ID] = member.Client
	}
	return out
}

// The list of people marks who is on the app; a browser carries no mark.
func TestMembersSayWhoIsOnTheApp(t *testing.T) {
	holdSeats(t)
	_, _, server := newHubTestServer(t, config.Config{})
	host := dialHubWS(t, server)
	helloHubClient(t, host, "host", 1)
	app := dialHubWS(t, server)
	welcome := helloApp(t, app, "friend")

	joined := nextOf(t, host, "members")
	require.Equal(t, map[string]string{"m1": "", "m2": ClientDesktop}, clientOf(joined.Members))

	late := dialHubWS(t, server)
	lateWelcome := helloHubClient(t, late, "late", 3)
	require.Equal(t, map[string]string{"m1": "", "m2": ClientDesktop, "m3": ""}, clientOf(lateWelcome.Members))
	nextOf(t, host, "members")

	require.NoError(t, app.Close())
	back := dialHubWS(t, server)
	resumed := resumeHubClient(t, back, "friend", welcome.MemberID, welcome.Capability, 4)
	require.Equal(t, "", clientOf(resumed.Members)["m2"], "the seat came back from a browser")
	require.Equal(t, "", clientOf(nextOf(t, host, "members").Members)["m2"])
}

// Only the seat that produces the source plays it from its own cache: a
// friend on the app plays the bucket like a browser does.
func TestAGuestOnTheAppAlsoNeedsTheBucket(t *testing.T) {
	_, _, server, generation := localRoom(t)
	host := dialHubWS(t, server)
	helloApp(t, host, "host")
	friend := dialHubWS(t, server)
	helloApp(t, friend, "friend")

	asked := nextOf(t, host, "needBrowserMedia")
	require.Equal(t, generation, asked.Generation)
}

// The producer keeps being the one asked for the media when the controls
// go to someone else, who has no cache to put up.
func TestTheProducerIsAskedEvenAfterHandingTheControlsAway(t *testing.T) {
	holdSeats(t)
	_, _, server, generation := localRoom(t)
	host := dialHubWS(t, server)
	welcome := helloApp(t, host, "host")
	guest := dialHubWS(t, server)
	helloHubClient(t, guest, "guest", 2)
	nextOf(t, host, "needBrowserMedia")

	require.NoError(t, host.WriteJSON(Inbound{Type: "transfer", TargetID: "m2"}))
	nextOf(t, guest, "members")
	requireNoEvent(t, guest, 50*time.Millisecond)

	require.NoError(t, host.Close())
	again := dialHubWS(t, server)
	require.NoError(t, again.WriteJSON(Inbound{
		Type: "hello", Nickname: "host", ClientTimeMs: 1, MemberID: welcome.MemberID, Capability: welcome.Capability,
		Client: "desktop", Features: []string{"localSource"},
	}))
	require.Equal(t, "welcome", readHubEvent(t, again).Type)
	asked := nextOf(t, again, "needBrowserMedia")
	require.Equal(t, generation, asked.Generation)
}

func TestTheHostIsAskedAgainWhenItComesBack(t *testing.T) {
	holdSeats(t)
	_, _, server, generation := localRoom(t)
	host := dialHubWS(t, server)
	welcome := helloApp(t, host, "host")
	guest := dialHubWS(t, server)
	helloHubClient(t, guest, "guest", 2)
	nextOf(t, host, "needBrowserMedia")
	require.NoError(t, host.Close())

	again := dialHubWS(t, server)
	require.NoError(t, again.WriteJSON(Inbound{
		Type: "hello", Nickname: "host", ClientTimeMs: 1, MemberID: welcome.MemberID, Capability: welcome.Capability,
		Client: "desktop", Features: []string{"localSource"},
	}))
	require.Equal(t, "welcome", readHubEvent(t, again).Type)

	asked := nextOf(t, again, "needBrowserMedia")
	require.Equal(t, generation, asked.Generation)
}

func TestTheHostIsAskedOnceTheMediaTurnsLocal(t *testing.T) {
	hub, store, server := newHubTestServer(t, config.Config{})
	host := dialHubWS(t, server)
	helloApp(t, host, "host")
	guest := dialHubWS(t, server)
	helloHubClient(t, guest, "guest", 2)
	require.Equal(t, "members", readHubEvent(t, host).Type)
	requireNoEvent(t, host, 50*time.Millisecond)

	_, generation, err := store.SwapSource(t.Context(), "r1", "m1", "Filme", room.StatusLocal, time.Now())
	require.NoError(t, err)
	hub.NotifyStatus("r1", room.StatusLocal)

	asked := nextOf(t, host, "needBrowserMedia")
	require.Equal(t, generation, asked.Generation)
}

// A guest with nothing to play yet, on a browser or on the app, waits on a
// short "preparing", and the producer starts without them.
func TestAGuestWithoutMediaDoesNotHoldTheGate(t *testing.T) {
	_, _, server, _ := localRoom(t)
	host := dialHubWS(t, server)
	helloApp(t, host, "host")
	friend := dialHubWS(t, server)
	helloApp(t, friend, "friend")
	guest := dialHubWS(t, server)
	helloHubClient(t, guest, "guest", 3)

	require.NoError(t, host.WriteJSON(Inbound{Type: "play", PositionMs: 60_000, Rate: 1}))
	require.False(t, nextOf(t, host, "state").State.Playing)
	nextOf(t, host, "waiting")
	require.NoError(t, host.WriteJSON(Inbound{Type: "ready", PositionMs: 60_000, BufferAheadMs: 5_000}))

	for {
		event := readHubEvent(t, host)
		if event.Type == "state" {
			require.True(t, event.State.Playing, "the producer waited for a guest with no media")
			return
		}
	}
}

func TestAGuestOnTheAppCountsForTheGateOnceTheMediaIsUp(t *testing.T) {
	hub, store, server, _ := localRoom(t)
	require.NoError(t, store.SetStatus(t.Context(), "r1", room.StatusReady))
	hub.NotifyStatus("r1", room.StatusReady)
	host := dialHubWS(t, server)
	helloApp(t, host, "host")
	friend := dialHubWS(t, server)
	helloApp(t, friend, "friend")

	require.NoError(t, host.WriteJSON(Inbound{Type: "play", PositionMs: 60_000, Rate: 1}))
	nextOf(t, host, "waiting")
	require.NoError(t, host.WriteJSON(Inbound{Type: "ready", PositionMs: 60_000, BufferAheadMs: 5_000}))

	waiting := nextOf(t, host, "waiting")
	byMember := map[string]MemberReadiness{}
	for _, member := range waiting.Readiness {
		byMember[member.MemberID] = member
	}
	require.False(t, byMember["m2"].Ready, "a guest app with media to load was skipped")
}

func TestABrowserCountsForTheGateOnceTheMediaIsUp(t *testing.T) {
	hub, store, server, _ := localRoom(t)
	require.NoError(t, store.SetStatus(t.Context(), "r1", room.StatusReady))
	hub.NotifyStatus("r1", room.StatusReady)
	host := dialHubWS(t, server)
	helloApp(t, host, "host")
	guest := dialHubWS(t, server)
	helloHubClient(t, guest, "guest", 2)

	require.NoError(t, host.WriteJSON(Inbound{Type: "play", PositionMs: 60_000, Rate: 1}))
	nextOf(t, host, "waiting")
	require.NoError(t, host.WriteJSON(Inbound{Type: "ready", PositionMs: 60_000, BufferAheadMs: 5_000}))

	waiting := nextOf(t, host, "waiting")
	byMember := map[string]MemberReadiness{}
	for _, member := range waiting.Readiness {
		byMember[member.MemberID] = member
	}
	require.False(t, byMember["m2"].Ready, "a browser with media to load was skipped")
}

package sync

import (
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
)

func twoMembers(t *testing.T) (*Hub, *room.Store, *websocket.Conn, *websocket.Conn, Outbound) {
	t.Helper()
	hub, store, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	host := dialHubWS(t, server)
	helloHubClient(t, host, "host", 1)
	guest := dialHubWS(t, server)
	guestWelcome := helloHubClient(t, guest, "guest", 2)
	require.Equal(t, "members", readHubEvent(t, host).Type)
	return hub, store, host, guest, guestWelcome
}

func storedRoom(t *testing.T, store *room.Store) *room.Room {
	t.Helper()
	r, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	return r
}

func TestStageRequestReachesTheHostAndAGrantLetsTheGuestOpenOnce(t *testing.T) {
	hub, store, host, guest, guestWelcome := twoMembers(t)
	r := storedRoom(t, store)
	require.False(t, hub.AuthorizeStage(r, "m2", guestWelcome.Capability, room.StageScreen, false))

	require.NoError(t, guest.WriteJSON(Inbound{Type: "stageRequest", Kind: room.StageScreen}))
	request := readHubEvent(t, host)
	require.Equal(t, "stageRequest", request.Type)
	require.Equal(t, "m2", request.MemberID)
	require.Equal(t, "guest", request.Nickname)
	require.Equal(t, room.StageScreen, request.Kind)
	require.NotEmpty(t, request.RequestID)

	require.NoError(t, host.WriteJSON(Inbound{Type: "stageAnswer", RequestID: request.RequestID, Allow: true}))
	grant := readHubEvent(t, guest)
	require.Equal(t, "stageGrant", grant.Type)
	require.Equal(t, room.StageScreen, grant.Kind)
	require.NotNil(t, grant.Allow)
	require.True(t, *grant.Allow)

	require.False(t, hub.AuthorizeStage(r, "m2", "wrong", room.StageScreen, false), "the capability still has to match")
	require.False(t, hub.AuthorizeStage(r, "m2", guestWelcome.Capability, room.StageMedia, false), "a grant is for one kind")
	require.True(t, hub.AuthorizeStage(r, "m2", guestWelcome.Capability, room.StageScreen, false), "peeking keeps the grant")
	require.True(t, hub.AuthorizeStage(r, "m2", guestWelcome.Capability, room.StageScreen, true))
	require.False(t, hub.AuthorizeStage(r, "m2", guestWelcome.Capability, room.StageScreen, true), "a grant opens once")
}

func TestADeniedStageRequestGrantsNothing(t *testing.T) {
	hub, store, host, guest, guestWelcome := twoMembers(t)
	require.NoError(t, guest.WriteJSON(Inbound{Type: "stageRequest", Kind: room.StageMedia}))
	request := readHubEvent(t, host)
	require.NoError(t, host.WriteJSON(Inbound{Type: "stageAnswer", RequestID: request.RequestID}))
	answer := readHubEvent(t, guest)
	require.Equal(t, "stageGrant", answer.Type)
	require.False(t, *answer.Allow)
	require.False(t, hub.AuthorizeStage(storedRoom(t, store), "m2", guestWelcome.Capability, room.StageMedia, true))
}

func TestOnlyTheHostAnswersStageRequests(t *testing.T) {
	_, _, host, guest, _ := twoMembers(t)
	require.NoError(t, guest.WriteJSON(Inbound{Type: "stageRequest", Kind: room.StageLive}))
	request := readHubEvent(t, host)
	require.NoError(t, guest.WriteJSON(Inbound{Type: "stageAnswer", RequestID: request.RequestID, Allow: true}))
	require.Equal(t, "not_controller", readHubEvent(t, guest).ErrCode)
}

func TestStageRequestsAreDeduplicatedAndValidated(t *testing.T) {
	_, _, host, guest, _ := twoMembers(t)
	require.NoError(t, guest.WriteJSON(Inbound{Type: "stageRequest", Kind: "member"}))
	require.Equal(t, "invalid_stage", readHubEvent(t, guest).ErrCode)

	require.NoError(t, guest.WriteJSON(Inbound{Type: "stageRequest", Kind: room.StageScreen}))
	first := readHubEvent(t, host)
	require.NoError(t, guest.WriteJSON(Inbound{Type: "stageRequest", Kind: room.StageScreen}))
	require.NoError(t, guest.WriteJSON(Inbound{Type: "heartbeat", ClientTimeMs: 7}))
	require.Equal(t, "pong", readHubEvent(t, guest).Type)
	require.NoError(t, host.WriteJSON(Inbound{Type: "heartbeat", ClientTimeMs: 8}))
	next := readHubEvent(t, host)
	require.Equal(t, "pong", next.Type, "a second ask for the same stage is not a second request: %s", first.RequestID)
}

func TestTheHostAndTheOwnerMayActOnAStageWithoutAGrant(t *testing.T) {
	hub, store, _, _, guestWelcome := twoMembers(t)
	r := storedRoom(t, store)
	r.ControllerID = "m1"
	r.SourceMemberID = "m2"
	r.Screens = []room.ScreenShare{{MemberID: "m2"}}
	r.Live = &room.LiveInfo{MemberID: "m2"}
	for _, kind := range []string{room.StageMedia, room.StageScreen, room.StageLive} {
		require.True(t, hub.AuthorizeStage(r, "m2", guestWelcome.Capability, kind, true), kind)
	}
	r.SourceMemberID, r.Screens, r.Live = "", nil, nil
	for _, kind := range []string{room.StageMedia, room.StageScreen, room.StageLive} {
		require.False(t, hub.AuthorizeStage(r, "m2", guestWelcome.Capability, kind, true), kind)
	}
}

func TestStageGrantsRunOut(t *testing.T) {
	previous := stageGrantTTL
	stageGrantTTL = 50 * time.Millisecond
	t.Cleanup(func() { stageGrantTTL = previous })
	hub, store, host, guest, guestWelcome := twoMembers(t)
	require.NoError(t, guest.WriteJSON(Inbound{Type: "stageRequest", Kind: room.StageScreen}))
	request := readHubEvent(t, host)
	require.NoError(t, host.WriteJSON(Inbound{Type: "stageAnswer", RequestID: request.RequestID, Allow: true}))
	require.Equal(t, "stageGrant", readHubEvent(t, guest).Type)
	time.Sleep(80 * time.Millisecond)
	require.False(t, hub.AuthorizeStage(storedRoom(t, store), "m2", guestWelcome.Capability, room.StageScreen, true))
}

func TestTheMediaOwnerDrivesThePlayback(t *testing.T) {
	_, store, host, guest, _ := twoMembers(t)
	_, _, err := store.SwapSource(t.Context(), "r1", "m2", "movie.mkv", "ready", time.Now())
	require.NoError(t, err)
	require.NoError(t, store.SetGatingDisabled(t.Context(), "r1", true))

	require.NoError(t, guest.WriteJSON(Inbound{Type: "play", PositionMs: 1_000, Rate: 1}))
	for _, conn := range []*websocket.Conn{host, guest} {
		event := readHubEvent(t, conn)
		require.Equal(t, "state", event.Type)
		require.True(t, event.State.Playing)
	}
}

func TestSpotlightIsTheHostsAndReachesEveryone(t *testing.T) {
	_, store, host, guest, _ := twoMembers(t)
	require.NoError(t, guest.WriteJSON(Inbound{Type: "spotlight", Kind: room.StageMedia}))
	require.Equal(t, "not_controller", readHubEvent(t, guest).ErrCode)

	require.NoError(t, host.WriteJSON(Inbound{Type: "spotlight", Kind: room.StageMember, TargetID: "m2"}))
	for _, conn := range []*websocket.Conn{host, guest} {
		event := readHubEvent(t, conn)
		require.Equal(t, "spotlight", event.Type)
		require.Equal(t, &room.Spotlight{Kind: room.StageMember, MemberID: "m2"}, event.Spotlight)
	}
	require.Equal(t, &room.Spotlight{Kind: room.StageMember, MemberID: "m2"}, storedRoom(t, store).Spotlight)

	require.NoError(t, host.WriteJSON(Inbound{Type: "spotlight", Kind: room.StageScreen}))
	require.Equal(t, "invalid_spotlight", readHubEvent(t, host).ErrCode, "a screen is named by its owner")

	require.NoError(t, host.WriteJSON(Inbound{Type: "spotlight"}))
	for _, conn := range []*websocket.Conn{host, guest} {
		event := readHubEvent(t, conn)
		require.Equal(t, "spotlight", event.Type)
		require.Nil(t, event.Spotlight)
	}
	require.Nil(t, storedRoom(t, store).Spotlight)
}

func TestTheHostClosesSomeonesScreen(t *testing.T) {
	_, store, host, guest, _ := twoMembers(t)
	require.NoError(t, store.StartScreenShare(t.Context(), "r1", room.ScreenShare{MemberID: "m2", Since: time.Now()}))

	require.NoError(t, host.WriteJSON(Inbound{Type: "stageClose", Kind: room.StageScreen, TargetID: "m2"}))
	closed := readHubEvent(t, guest)
	require.Equal(t, "stageClosed", closed.Type)
	require.Equal(t, room.StageScreen, closed.Kind)
	require.Equal(t, "roomUpdated", readHubEvent(t, guest).Type)
	require.Equal(t, "roomUpdated", readHubEvent(t, host).Type)
	require.Empty(t, storedRoom(t, store).Screens)
}

func TestAGuestClosesOnlyTheirOwnStage(t *testing.T) {
	_, store, host, guest, _ := twoMembers(t)
	require.NoError(t, store.StartScreenShare(t.Context(), "r1", room.ScreenShare{MemberID: "m1", Since: time.Now()}))
	require.NoError(t, guest.WriteJSON(Inbound{Type: "stageClose", Kind: room.StageScreen, TargetID: "m1"}))
	require.Equal(t, "not_stage_owner", readHubEvent(t, guest).ErrCode)
	require.NoError(t, guest.WriteJSON(Inbound{Type: "stageClose", Kind: room.StageMedia}))
	require.Equal(t, "not_stage_owner", readHubEvent(t, guest).ErrCode)
	require.Len(t, storedRoom(t, store).Screens, 1)
	_ = host
}

func TestClosingTheMediaOrTheLiveHandsItToTheServer(t *testing.T) {
	hub, store, host, _, _ := twoMembers(t)
	closed := make(chan string, 2)
	hub.OnStageClose(func(roomID, kind string) { closed <- roomID + "/" + kind })
	_, _, err := store.SwapSource(t.Context(), "r1", "m1", "movie.mkv", "ready", time.Now())
	require.NoError(t, err)

	require.NoError(t, host.WriteJSON(Inbound{Type: "stageClose", Kind: room.StageMedia}))
	select {
	case got := <-closed:
		require.Equal(t, "r1/media", got)
	case <-time.After(time.Second):
		t.Fatal("media close never reached the server")
	}
}

func TestANewHostInheritsTheOpenStageRequests(t *testing.T) {
	_, _, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	host := dialHubWS(t, server)
	helloHubClient(t, host, "host", 1)
	guest := dialHubWS(t, server)
	helloHubClient(t, guest, "guest", 2)
	require.Equal(t, "members", readHubEvent(t, host).Type)
	third := dialHubWS(t, server)
	helloHubClient(t, third, "third", 3)
	require.Equal(t, "members", readHubEvent(t, host).Type)
	require.Equal(t, "members", readHubEvent(t, guest).Type)

	require.NoError(t, guest.WriteJSON(Inbound{Type: "stageRequest", Kind: room.StageScreen}))
	require.Equal(t, "stageRequest", readHubEvent(t, host).Type)
	require.NoError(t, host.WriteJSON(Inbound{Type: "transfer", TargetID: "m3"}))
	require.Equal(t, "members", readHubEvent(t, third).Type)
	inherited := readHubEvent(t, third)
	require.Equal(t, "stageRequest", inherited.Type)
	require.Equal(t, "m2", inherited.MemberID)
}

func TestOnlyTheMediaOwnerOrTheHostNamesTheSourceOrigin(t *testing.T) {
	_, store, host, guest, _ := twoMembers(t)
	_, _, err := store.SwapSource(t.Context(), "r1", "m1", "movie.mkv", "uploading", time.Now())
	require.NoError(t, err)

	require.NoError(t, guest.WriteJSON(Inbound{Type: "source", Origin: "file"}))
	require.NoError(t, guest.WriteJSON(Inbound{Type: "heartbeat", ClientTimeMs: 3}))
	require.Equal(t, "pong", readHubEvent(t, guest).Type)
	require.Equal(t, "m1", storedRoom(t, store).SourceMemberID)

	require.NoError(t, host.WriteJSON(Inbound{Type: "source", Origin: "torrent"}))
	require.Equal(t, "roomUpdated", readHubEvent(t, host).Type)
	got := storedRoom(t, store)
	require.Equal(t, "m1", got.SourceMemberID)
	require.Equal(t, "torrent", got.SourceOrigin)
}

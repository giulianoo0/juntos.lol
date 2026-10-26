package sync

import (
	"testing"

	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
)

func boolPtr(value bool) *bool { return &value }

func memberByID(t *testing.T, members []room.Member, id string) room.Member {
	t.Helper()
	for _, member := range members {
		if member.ID == id {
			return member
		}
	}
	t.Fatalf("member %s not in %v", id, members)
	return room.Member{}
}

func callRoom(t *testing.T) (host, guest *websocket.Conn) {
	t.Helper()
	_, _, server := newHubTestServer(t, config.Config{})
	host = dialHubWS(t, server)
	helloHubClient(t, host, "host", 1)
	guest = dialHubWS(t, server)
	helloHubClient(t, guest, "guest", 2)
	require.Equal(t, "members", readHubEvent(t, host).Type)
	return host, guest
}

func TestCallMediaIsAnnouncedToEveryone(t *testing.T) {
	host, guest := callRoom(t)

	require.NoError(t, guest.WriteJSON(Inbound{Type: "media", Mic: boolPtr(true), Cam: boolPtr(true)}))
	for _, conn := range []*websocket.Conn{host, guest} {
		event := readHubEvent(t, conn)
		require.Equal(t, "members", event.Type)
		member := memberByID(t, event.Members, "m2")
		require.True(t, member.Mic)
		require.True(t, member.Cam)
	}

	// A field left out keeps its value.
	require.NoError(t, guest.WriteJSON(Inbound{Type: "media", Cam: boolPtr(false)}))
	member := memberByID(t, readHubEvent(t, host).Members, "m2")
	require.True(t, member.Mic)
	require.False(t, member.Cam)
}

func TestCallHostMuteSilencesTheTarget(t *testing.T) {
	host, guest := callRoom(t)
	require.NoError(t, guest.WriteJSON(Inbound{Type: "media", Mic: boolPtr(true), Cam: boolPtr(true)}))
	readHubEvent(t, host)
	readHubEvent(t, guest)

	require.NoError(t, host.WriteJSON(Inbound{Type: "hostMute", TargetID: "m2"}))
	force := readHubEvent(t, guest)
	require.Equal(t, "forceMedia", force.Type)
	require.NotNil(t, force.Mic)
	require.False(t, *force.Mic)
	require.Nil(t, force.Cam)
	for _, conn := range []*websocket.Conn{host, guest} {
		event := readHubEvent(t, conn)
		require.Equal(t, "members", event.Type)
		member := memberByID(t, event.Members, "m2")
		require.False(t, member.Mic)
		require.True(t, member.HostMuted)
		require.True(t, member.Cam)
	}

	// Turning the microphone back on is the member's own call, and lifts the host's mute.
	require.NoError(t, guest.WriteJSON(Inbound{Type: "media", Mic: boolPtr(true)}))
	member := memberByID(t, readHubEvent(t, host).Members, "m2")
	require.True(t, member.Mic)
	require.False(t, member.HostMuted)
}

func TestCallHostCamOffStopsTheCamera(t *testing.T) {
	host, guest := callRoom(t)
	require.NoError(t, guest.WriteJSON(Inbound{Type: "media", Mic: boolPtr(true), Cam: boolPtr(true)}))
	readHubEvent(t, host)
	readHubEvent(t, guest)

	require.NoError(t, host.WriteJSON(Inbound{Type: "hostCamOff", TargetID: "m2"}))
	force := readHubEvent(t, guest)
	require.Equal(t, "forceMedia", force.Type)
	require.NotNil(t, force.Cam)
	require.False(t, *force.Cam)
	require.Nil(t, force.Mic)
	member := memberByID(t, readHubEvent(t, host).Members, "m2")
	require.False(t, member.Cam)
	require.True(t, member.HostCamOff)
	require.True(t, member.Mic)
}

func TestCallOnlyTheHostForcesMedia(t *testing.T) {
	host, guest := callRoom(t)
	require.NoError(t, guest.WriteJSON(Inbound{Type: "hostMute", TargetID: "m1"}))
	refused := readHubEvent(t, guest)
	require.Equal(t, "error", refused.Type)
	require.Equal(t, "not_controller", refused.ErrCode)

	require.NoError(t, host.WriteJSON(Inbound{Type: "hostCamOff", TargetID: "m9"}))
	missing := readHubEvent(t, host)
	require.Equal(t, "error", missing.Type)
	require.Equal(t, "member_not_found", missing.ErrCode)
}

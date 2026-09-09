package sync

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
)

func TestLiveCountsOnlyRoomsWithSomeoneInThem(t *testing.T) {
	h := &Hub{capabilities: map[string]map[string]string{
		"busy":    {"m1": "cap-1", "m2": "cap-2"},
		"alone":   {"m3": "cap-3"},
		"emptied": {},
	}}

	rooms, members := h.Live()

	require.Equal(t, 2, rooms)
	require.Equal(t, 3, members)
}

func TestLiveOnAQuietServer(t *testing.T) {
	h := &Hub{capabilities: map[string]map[string]string{}}

	rooms, members := h.Live()

	require.Zero(t, rooms)
	require.Zero(t, members)
}

func TestHubDropsScreenShareOnDisconnect(t *testing.T) {
	_, store, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	host := dialHubWS(t, server)
	helloHubClient(t, host, "host", 1)
	guest := dialHubWS(t, server)
	helloHubClient(t, guest, "guest", 2)
	require.Equal(t, "members", readHubEvent(t, host).Type)

	now := time.Now().UTC()
	require.NoError(t, store.StartScreenShare(t.Context(), "r1", room.ScreenShare{MemberID: "m1", Nickname: "host", Since: now}, true))
	require.NoError(t, store.StartScreenShare(t.Context(), "r1", room.ScreenShare{MemberID: "m2", Nickname: "guest", Since: now.Add(time.Second)}, false))

	require.NoError(t, guest.Close())
	require.Equal(t, "roomUpdated", readHubEvent(t, host).Type)
	require.Equal(t, "members", readHubEvent(t, host).Type)

	stored, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Len(t, stored.Screens, 1)
	require.Equal(t, "m1", stored.Screens[0].MemberID)
}

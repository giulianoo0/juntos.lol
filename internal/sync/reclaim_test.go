package sync

import (
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
)

func TestUnfinishedWorkProtectsAPreparingRoom(t *testing.T) {
	// The host's remux flips the room to ready seconds in and keeps
	// publishing for minutes after, so an empty room mid-preparo is work in
	// progress, not an abandoned one.
	now := time.Now()
	r := &room.Room{Status: "uploading", CreatedAt: now.Add(-2 * time.Minute)}

	require.NotEmpty(t, unfinishedWork(r, now))
}

func TestUnfinishedWorkGivesUpOnARoomStuckPreparing(t *testing.T) {
	// Protected is not protected forever: a source that has not become
	// playable in ten minutes with nobody watching is holding a worker and a
	// torrent open for a room that is never going to be watched.
	now := time.Now()
	r := &room.Room{Status: "uploading", CreatedAt: now.Add(-11 * time.Minute)}

	require.Empty(t, unfinishedWork(r, now))
}

func TestUnfinishedWorkReclaimsAFailedRoomAtOnce(t *testing.T) {
	// A failure has nothing left to protect, whatever stage it stopped in.
	now := time.Now()
	for _, r := range []*room.Room{
		{Status: "error", CreatedAt: now},
		{Status: "uploading", ErrorMessage: "plan failed", CreatedAt: now},
	} {
		require.Empty(t, unfinishedWork(r, now))
	}
}

func TestUnfinishedWorkKeepsARoomWhoseSourceIsStillArriving(t *testing.T) {
	now := time.Now()
	r := &room.Room{
		Status:      "ready",
		CreatedAt:   now.Add(-time.Minute),
		Preparation: room.Preparation{SourceBytes: 1000, ReceivedBytes: 400},
	}

	require.NotEmpty(t, unfinishedWork(r, now))
}

func TestUnfinishedWorkReleasesAFinishedRoom(t *testing.T) {
	now := time.Now()
	r := &room.Room{
		Status:      "ready",
		CreatedAt:   now.Add(-time.Minute),
		Preparation: room.Preparation{SourceBytes: 1000, ReceivedBytes: 1000},
	}

	require.Empty(t, unfinishedWork(r, now))
}

func TestAbandonedSweepReclaimsAnEmptyRoomNobodyIsWatching(t *testing.T) {
	// The idle timer fires once per goroutine; a room it spared, or one whose
	// goroutine died with the process, has to be picked up by the sweep.
	hub, store, _ := newHubTestServer(t, config.Config{})
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "done", Status: "ready",
		CreatedAt: now.Add(-preparingGrace - time.Minute), ExpiresAt: now.Add(time.Hour),
	}))
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "busy", Status: "ready",
		CreatedAt: now.Add(-time.Minute), ExpiresAt: now.Add(time.Hour),
	}))
	for _, id := range []string{"done", "busy"} {
		require.NoError(t, store.SetIngestProgress(t.Context(), id, 400, 1000))
	}
	var reclaimed []string
	hub.OnRoomReclaimed(func(id string) { reclaimed = append(reclaimed, id) })

	hub.sweepAbandoned()

	_, err := store.Get(t.Context(), "done")
	require.ErrorIs(t, err, room.ErrNotFound)
	_, err = store.Get(t.Context(), "busy")
	require.NoError(t, err)
	require.Contains(t, reclaimed, "done")
	require.NotContains(t, reclaimed, "busy")
}

func TestHubTransferHandsTheControlsToTheTarget(t *testing.T) {
	_, _, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	host := dialHubWS(t, server)
	helloHubClient(t, host, "host", 1)
	guest := dialHubWS(t, server)
	helloHubClient(t, guest, "guest", 2)
	require.Equal(t, "members", readHubEvent(t, host).Type)

	// A guest asking is refused; the host asking is honoured for everyone.
	require.NoError(t, guest.WriteJSON(Inbound{Type: "transfer", TargetID: "m2"}))
	require.Equal(t, "not_controller", readHubEvent(t, guest).ErrCode)
	require.NoError(t, host.WriteJSON(Inbound{Type: "transfer", TargetID: "m2"}))
	for _, conn := range []*websocket.Conn{host, guest} {
		members := readHubEvent(t, conn)
		require.Equal(t, "members", members.Type)
		require.Equal(t, "m2", members.ControllerID)
	}
}

func TestHubKickTellsTheMemberAndDropsThem(t *testing.T) {
	_, _, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	host := dialHubWS(t, server)
	helloHubClient(t, host, "host", 1)
	guest := dialHubWS(t, server)
	helloHubClient(t, guest, "guest", 2)
	require.Equal(t, "members", readHubEvent(t, host).Type)

	require.NoError(t, host.WriteJSON(Inbound{Type: "kick", TargetID: "m2"}))
	require.Equal(t, "kicked", readHubEvent(t, guest).ErrCode)
	var closed Outbound
	require.Error(t, guest.ReadJSON(&closed), "the socket stayed open behind the kick")
	members := readHubEvent(t, host)
	require.Equal(t, "members", members.Type)
	require.Len(t, members.Members, 1)
}

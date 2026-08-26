package sync

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

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

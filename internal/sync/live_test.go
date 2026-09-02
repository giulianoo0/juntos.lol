package sync

import (
	"testing"

	"github.com/stretchr/testify/require"
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

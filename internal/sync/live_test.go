package sync

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestLiveCountsOnlyRoomsWithSomeoneInThem(t *testing.T) {
	tests := []struct {
		name           string
		capabilities   map[string]map[string]string
		rooms, members int
	}{
		{name: "quiet server", capabilities: map[string]map[string]string{}},
		{name: "an emptied room does not count", capabilities: map[string]map[string]string{
			"busy":    {"m1": "cap-1", "m2": "cap-2"},
			"alone":   {"m3": "cap-3"},
			"emptied": {},
		}, rooms: 2, members: 3},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rooms, members := (&Hub{capabilities: tt.capabilities}).Live()
			require.Equal(t, tt.rooms, rooms)
			require.Equal(t, tt.members, members)
		})
	}
}

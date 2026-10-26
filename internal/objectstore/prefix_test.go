package objectstore

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestRoomPrefixCoversEveryGenerationOfOneRoom(t *testing.T) {
	prefix := RoomPrefix("r1")

	require.Equal(t, "rooms/r1/", prefix)
	require.True(t, strings.HasPrefix("rooms/r1/g0/hls/stream_0_000.m4s", prefix))
	require.True(t, strings.HasPrefix("rooms/r1/g3/subs/sub_0_eng.vtt", prefix))
	require.False(t, strings.HasPrefix("rooms/r10/g0/hls/stream_0_000.m4s", prefix))
}

func TestRemovePrefixRefusesToEmptyTheWholeBucket(t *testing.T) {
	require.ErrorIs(t, (&R2{}).RemovePrefix(t.Context(), ""), ErrEmptyPrefix)
}

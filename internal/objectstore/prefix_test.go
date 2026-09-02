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

func TestFakeRemovePrefixTakesOnlyTheMatchingRoom(t *testing.T) {
	fake := NewFake()
	for _, key := range []string{
		"rooms/r1/g0/hls/stream_0_000.m4s",
		"rooms/r1/g1/subs/sub_0_eng.vtt",
		"rooms/r10/g0/hls/stream_0_000.m4s",
	} {
		require.NoError(t, fake.Put(t.Context(), key, strings.NewReader("x"), 1, "", ""))
	}

	require.NoError(t, fake.RemovePrefix(t.Context(), RoomPrefix("r1")))

	require.Equal(t, []string{"rooms/r10/g0/hls/stream_0_000.m4s"}, fake.Keys())
}

func TestRemovePrefixRefusesToEmptyTheWholeBucket(t *testing.T) {
	fake := NewFake()
	require.NoError(t, fake.Put(t.Context(), "rooms/r1/g0/hls/a.m4s", strings.NewReader("x"), 1, "", ""))

	require.Error(t, fake.RemovePrefix(t.Context(), ""))
	require.Len(t, fake.Keys(), 1)
}

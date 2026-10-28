package account

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestCensusCountsWithoutNamingAnyone(t *testing.T) {
	store := newTestStore(t)
	ctx := t.Context()
	ana, err := store.SignInDiscord(ctx, DiscordUser{ID: "111", GlobalName: "Ana"})
	require.NoError(t, err)
	bia, err := store.SignInDiscord(ctx, DiscordUser{ID: "222", GlobalName: "Bia"})
	require.NoError(t, err)
	public := VisibilityPublic
	_, err = store.Update(ctx, ana.ID, Changes{Visibility: &public})
	require.NoError(t, err)
	_, err = store.StartSession(ctx, ana.ID)
	require.NoError(t, err)
	_, err = store.RequestFriend(ctx, ana.ID, bia.ID)
	require.NoError(t, err)
	require.NoError(t, store.AcceptFriend(ctx, bia.ID, ana.ID))
	require.NoError(t, store.RecordWatch(ctx, ana.ID, Watch{RoomID: "R1", Kind: "torrent", StartedAt: time.Now(), DurationSec: 600}))
	require.NoError(t, store.RecordWatch(ctx, bia.ID, Watch{RoomID: "R1", Kind: "torrent", StartedAt: time.Now(), DurationSec: 300}))

	census, err := store.Census(ctx, time.Now().AddDate(0, 0, -1))
	require.NoError(t, err)
	require.Equal(t, int64(2), census.Total)
	require.Equal(t, int64(1), census.Public)
	require.Equal(t, int64(1), census.SignedIn)
	require.Equal(t, int64(1), census.Friendships)
	require.Equal(t, int64(2), census.Watches)
	require.Equal(t, int64(900), census.WatchedSeconds)
	require.Equal(t, map[string]int64{"torrent": 2}, census.WatchesByKind)
	var opened int64
	for _, n := range census.NewByDay {
		opened += n
	}
	require.Equal(t, int64(2), opened)
}

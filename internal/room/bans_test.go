package room

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

func TestBanMatchesTheSameSeatBrowserAccountOrAddress(t *testing.T) {
	ban := Ban{ID: "m2", Capability: BanHash("cap"), Device: BanHash("dev"), AccountID: 7, IP: BanHash("203.0.113.9")}

	require.True(t, ban.Matches(Arrival{MemberID: "m2", Capability: "cap"}), "the seat coming back")
	require.True(t, ban.Matches(Arrival{Device: "dev"}), "the same browser")
	require.True(t, ban.Matches(Arrival{AccountID: 7}), "the same account")
	require.True(t, ban.Matches(Arrival{IP: "203.0.113.9"}), "the same address")

	require.False(t, ban.Matches(Arrival{MemberID: "m2", Capability: "other"}), "a guessed member id")
	require.False(t, ban.Matches(Arrival{Device: "other", IP: "198.51.100.1", AccountID: 8}))
	require.False(t, ban.Matches(Arrival{}), "nothing known matches nothing")
	require.False(t, Ban{ID: "m3"}.Matches(Arrival{MemberID: "m3"}), "an empty hash never matches")
}

func TestBansRoundTripAndGoWithTheRoom(t *testing.T) {
	mr := miniredis.RunT(t)
	s := NewStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}), time.Hour)
	ctx := context.Background()
	now := time.Now()
	require.NoError(t, s.Create(ctx, &Room{ID: "abc", Status: "ready", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}))

	require.NoError(t, s.AddBan(ctx, "abc", Ban{ID: "m3", Nickname: "b", At: now.Add(time.Second)}))
	require.NoError(t, s.AddBan(ctx, "abc", Ban{ID: "m2", Nickname: "a", At: now}))
	bans, err := s.Bans(ctx, "abc")
	require.NoError(t, err)
	require.Equal(t, []string{"m2", "m3"}, []string{bans[0].ID, bans[1].ID})
	require.Positive(t, mr.TTL(bansKey("abc")))

	removed, err := s.RemoveBan(ctx, "abc", "m2")
	require.NoError(t, err)
	require.True(t, removed)
	removed, err = s.RemoveBan(ctx, "abc", "m2")
	require.NoError(t, err)
	require.False(t, removed)

	require.NoError(t, s.Delete(ctx, "abc"))
	bans, err = s.Bans(ctx, "abc")
	require.NoError(t, err)
	require.Empty(t, bans)
}

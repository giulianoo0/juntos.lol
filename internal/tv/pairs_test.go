package tv

import (
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

func newTestPairs(t *testing.T) (*Pairs, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })
	return NewPairs(rdb), mr
}

// The code is read off a TV across the room: no O and 0, no I, L and 1.
func TestPairCodeIsEightCharactersNoneOfThemLookAlikes(t *testing.T) {
	pairs, _ := newTestPairs(t)

	for range 50 {
		pair, err := pairs.Start(t.Context())
		require.NoError(t, err)
		require.Regexp(t, `^[A-HJKMNP-Z2-9]{8}$`, pair.Code)
	}
	pair, err := pairs.Start(t.Context())

	require.NoError(t, err)
	require.NotEmpty(t, pair.ID)
	require.WithinDuration(t, time.Now().Add(PairTTL), pair.ExpiresAt, 5*time.Second)
}

func TestPairIsLinkedOnceAndHandedOverOnce(t *testing.T) {
	pairs, _ := newTestPairs(t)
	ctx := t.Context()
	pair, err := pairs.Start(ctx)
	require.NoError(t, err)

	_, err = pairs.Poll(ctx, pair.ID)
	require.ErrorIs(t, err, ErrPending)

	typed := strings.ToLower(pair.Code[:4] + "-" + pair.Code[4:])
	pairID, err := pairs.Claim(ctx, typed)
	require.NoError(t, err)
	require.Equal(t, pair.ID, pairID)
	_, err = pairs.Claim(ctx, pair.Code)
	require.ErrorIs(t, err, ErrNotFound, "um código vincula uma TV só")

	require.NoError(t, pairs.Complete(ctx, pairID, Linked{Token: "tok", Device: DeviceCard{ID: "d1", Name: "TV"}}))
	linked, err := pairs.Poll(ctx, pair.ID)
	require.NoError(t, err)
	require.Equal(t, "tok", linked.Token)
	_, err = pairs.Poll(ctx, pair.ID)
	require.ErrorIs(t, err, ErrNotFound, "o token sai uma vez só")
}

func TestPairLapses(t *testing.T) {
	pairs, mr := newTestPairs(t)
	pair, err := pairs.Start(t.Context())
	require.NoError(t, err)

	mr.FastForward(PairTTL + time.Second)

	_, err = pairs.Claim(t.Context(), pair.Code)
	require.ErrorIs(t, err, ErrNotFound)
	_, err = pairs.Poll(t.Context(), pair.ID)
	require.ErrorIs(t, err, ErrNotFound)
}

func TestClaimRefusesWhatIsNotACode(t *testing.T) {
	pairs, _ := newTestPairs(t)
	for _, code := range []string{"", "ABC", "*", "ABCD-EFGH-IJKL"} {
		_, err := pairs.Claim(t.Context(), code)
		require.ErrorIs(t, err, ErrNotFound, code)
	}
}

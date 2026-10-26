package room

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

func TestAccessDefaultsToOpenAndRoundTrips(t *testing.T) {
	mr := miniredis.RunT(t)
	s := NewStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}), time.Hour)
	ctx := context.Background()
	now := time.Now()
	require.NoError(t, s.Create(ctx, &Room{ID: "abc", Status: "ready", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}))

	access, err := s.Access(ctx, "abc")
	require.NoError(t, err)
	require.Equal(t, JoinOpen, access.Mode)
	require.Empty(t, access.PasswordHash)

	require.NoError(t, s.SetAccess(ctx, "abc", Access{Mode: JoinPassword, PasswordHash: "hash"}))
	access, err = s.Access(ctx, "abc")
	require.NoError(t, err)
	require.Equal(t, Access{Mode: JoinPassword, PasswordHash: "hash"}, access)

	got, err := s.Get(ctx, "abc")
	require.NoError(t, err)
	require.Equal(t, JoinPassword, got.JoinMode, "the room says how it is entered")

	require.NoError(t, s.SetAccess(ctx, "abc", Access{Mode: JoinApproval}))
	access, err = s.Access(ctx, "abc")
	require.NoError(t, err)
	require.Equal(t, Access{Mode: JoinApproval}, access, "leaving password mode drops the hash")

	_, err = s.Access(ctx, "missing")
	require.ErrorIs(t, err, ErrNotFound)
}

func TestValidJoinMode(t *testing.T) {
	for _, mode := range []string{JoinOpen, JoinPassword, JoinApproval} {
		require.True(t, ValidJoinMode(mode))
	}
	require.False(t, ValidJoinMode(""))
	require.False(t, ValidJoinMode("secret"))
}

package room

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

func TestCreateGetRoundTrip(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	s := NewStore(rdb, 5*time.Hour)
	r := &Room{ID: "abc", FileName: "movie.mkv", Status: "uploading",
		ControllerID: "m1", CreatedAt: time.Now(), ExpiresAt: time.Now().Add(5 * time.Hour)}
	require.NoError(t, s.Create(context.Background(), r))
	got, err := s.Get(context.Background(), "abc")
	require.NoError(t, err)
	require.Equal(t, "movie.mkv", got.FileName)
	require.Equal(t, "uploading", got.Status)
	ttl := mr.TTL("room:abc")
	require.Greater(t, ttl, 4*time.Hour)
}

func TestChatCappedAt200(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	s := NewStore(rdb, 5*time.Hour)
	r := &Room{ID: "abc", FileName: "movie.mkv", Status: "ready",
		ControllerID: "m1", CreatedAt: time.Now(), ExpiresAt: time.Now().Add(5 * time.Hour)}
	require.NoError(t, s.Create(context.Background(), r))

	ctx := context.Background()
	for i := 1; i <= 210; i++ {
		require.NoError(t, s.AddMessage(ctx, "abc", ChatMessage{
			Author: "alice",
			Text:   fmt.Sprintf("message %d", i),
			At:     time.Now(),
		}))
	}

	msgs, err := s.Messages(ctx, "abc")
	require.NoError(t, err)
	require.Len(t, msgs, 200)
	require.Equal(t, "message 11", msgs[0].Text)
	require.Equal(t, "message 210", msgs[199].Text)
}

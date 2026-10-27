package main

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/account"
	"github.com/giulianoo0/ss/internal/db/dbtest"
	"github.com/giulianoo0/ss/internal/worker"
)

const sessionToken = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

// seedRedis writes the keys the way the Redis account store and registry
// left them in production.
func seedRedis(t *testing.T, mr *miniredis.Miniredis, now time.Time) {
	t.Helper()
	ctx := t.Context()
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()
	created := now.Add(-48 * time.Hour).UTC().Truncate(time.Second).Format(time.RFC3339)
	accounts := map[string]map[string]any{
		"3": {"discordId": "d3", "nickname": "Ana", "avatar": "fox.bowtie", "visibility": "friends",
			"discordVisibility": "public", "discordUsername": "ana", "discordGlobalName": "Ana",
			"createdAt": created, "sessions": "2", "watchedSeconds": "5400"},
		"7": {"discordId": "d7", "nickname": "Bia", "avatar": "", "visibility": "private",
			"createdAt": created, "sessions": "0", "watchedSeconds": "0"},
		"9": {"discordId": "d9", "nickname": "Caio", "avatar": "", "visibility": "public",
			"discordVisibility": "private", "createdAt": created, "sessions": "0", "watchedSeconds": "0"},
	}
	for id, fields := range accounts {
		require.NoError(t, rdb.HSet(ctx, "account:"+id, fields).Err())
		require.NoError(t, rdb.Set(ctx, "account:discord:"+fields["discordId"].(string), id, 0).Err())
	}
	require.NoError(t, rdb.Set(ctx, "account:seq", 11, 0).Err())
	require.NoError(t, rdb.SAdd(ctx, "account:3:friends", 7).Err())
	require.NoError(t, rdb.SAdd(ctx, "account:7:friends", 3).Err())
	require.NoError(t, rdb.SAdd(ctx, "account:9:requests:out", 3).Err())
	require.NoError(t, rdb.SAdd(ctx, "account:3:requests:in", 9).Err())
	start := time.Date(2026, 10, 1, 20, 0, 0, 0, time.UTC)
	for _, watch := range []account.Watch{
		{RoomID: "abc", Title: "Filme", Kind: "file", StartedAt: start, DurationSec: 3600, With: []int64{7}},
		{RoomID: "abc", Title: "Outro", Kind: "youtube", StartedAt: start.Add(time.Hour), DurationSec: 1800},
	} {
		raw, err := json.Marshal(watch)
		require.NoError(t, err)
		require.NoError(t, rdb.LPush(ctx, "account:3:history", raw).Err())
	}
	require.NoError(t, rdb.Set(ctx, "account:session:"+sessionToken, 3, 30*24*time.Hour).Err())
	invite, err := json.Marshal(account.RoomInvite{From: 7, RoomID: "ROOM7777", At: now.Add(-time.Minute).UTC().Truncate(time.Second)})
	require.NoError(t, err)
	require.NoError(t, rdb.HSet(ctx, "account:3:invites", "7", invite).Err())
	require.NoError(t, rdb.HSet(ctx, "worker:w_abc123", "pubkey", "pk", "publicBase", "https://w.test",
		"enrolledAt", created, "certNotAfter", "1900000000").Err())
	require.NoError(t, rdb.SAdd(ctx, "worker:w_abc123:jobs", "t_1").Err())
	require.NoError(t, rdb.ZAdd(ctx, "workers:by_seen", redis.Z{Score: 1, Member: "w_abc123"}).Err())
	// Rooms stay in Redis and must not be touched.
	require.NoError(t, rdb.HSet(ctx, "room:ABCD1234", "name", "Sexta").Err())
}

func TestImportCarriesEverythingAndRunsTwiceWithoutDuplicates(t *testing.T) {
	mr := miniredis.RunT(t)
	now := time.Now()
	seedRedis(t, mr, now)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })
	pool := dbtest.New(t)
	ctx := t.Context()

	first, err := importAll(ctx, rdb, pool)
	require.NoError(t, err)
	second, err := importAll(ctx, rdb, pool)
	require.NoError(t, err)

	require.Equal(t, first, second, "rodar de novo não muda nada")
	for _, row := range second {
		require.Equal(t, row.Redis, row.Postgres, row.Name)
	}
	require.Equal(t, []count{
		{Name: "contas", Redis: 3, Postgres: 3},
		{Name: "amizades", Redis: 1, Postgres: 1},
		{Name: "pedidos", Redis: 1, Postgres: 1},
		{Name: "histórico", Redis: 2, Postgres: 2},
		{Name: "sessões", Redis: 1, Postgres: 1},
		{Name: "convites", Redis: 1, Postgres: 1},
		{Name: "workers", Redis: 1, Postgres: 1},
	}, second)

	store := account.NewStore(pool)
	ana, err := store.Get(ctx, 3)
	require.NoError(t, err)
	require.Equal(t, "Ana", ana.Nickname)
	require.Equal(t, "fox.bowtie", ana.Avatar)
	require.Equal(t, account.VisibilityFriends, ana.Visibility)
	require.Equal(t, account.VisibilityPublic, ana.DiscordVisibility)
	require.Equal(t, "ana", ana.DiscordUsername)
	require.Equal(t, int64(2), ana.Sessions)
	require.Equal(t, int64(5400), ana.WatchedSeconds)
	require.Equal(t, now.Add(-48*time.Hour).UTC().Truncate(time.Second), ana.CreatedAt)
	byDiscord, err := store.ByDiscord(ctx, "d9")
	require.NoError(t, err)
	require.Equal(t, int64(9), byDiscord.ID)

	friends, err := store.Friends(ctx, 7)
	require.NoError(t, err)
	require.Equal(t, []int64{3}, friends)
	incoming, _, err := store.FriendRequests(ctx, 3)
	require.NoError(t, err)
	require.Equal(t, []int64{9}, incoming)
	history, err := store.History(ctx, 3, 10)
	require.NoError(t, err)
	require.Len(t, history, 2)
	require.Equal(t, "Outro", history[0].Title)
	require.Equal(t, []int64{7}, history[1].With)
	signedIn, err := store.SessionAccount(ctx, sessionToken)
	require.NoError(t, err)
	require.Equal(t, int64(3), signedIn, "quem estava logado continua logado")
	invites, err := store.Invites(ctx, 3, now)
	require.NoError(t, err)
	require.Len(t, invites, 1)

	key, err := worker.NewPGEnrollments(pool).PubKey(ctx, "w_abc123")
	require.NoError(t, err)
	require.Equal(t, "pk", key)

	fresh, err := store.SignInDiscord(ctx, account.DiscordUser{ID: "novo", GlobalName: "Novo"})
	require.NoError(t, err)
	require.Equal(t, int64(12), fresh.ID, "a numeração continua de onde o Redis parou")
}

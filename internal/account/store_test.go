package account

import (
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })
	return NewStore(rdb)
}

func TestSignInDiscordNumbersAccountsInOrderAndFindsThemAgain(t *testing.T) {
	store := newTestStore(t)
	ctx := t.Context()

	first, err := store.SignInDiscord(ctx, DiscordUser{ID: "111", GlobalName: "Ana"})
	require.NoError(t, err)
	second, err := store.SignInDiscord(ctx, DiscordUser{ID: "222", GlobalName: "Bia"})
	require.NoError(t, err)
	again, err := store.SignInDiscord(ctx, DiscordUser{ID: "111", GlobalName: "Ana renomeada no Discord"})
	require.NoError(t, err)

	require.Equal(t, int64(1), first.ID)
	require.Equal(t, int64(2), second.ID)
	require.Equal(t, first.ID, again.ID)
	require.Equal(t, "Ana", again.Nickname, "o apelido do juntos não segue o Discord depois de criado")
	require.Equal(t, VisibilityPrivate, first.Visibility, "conta nova nasce com o histórico privado")
	require.Equal(t, VisibilityPrivate, first.DiscordVisibility, "o Discord nasce escondido")
	third, err := store.SignInDiscord(ctx, DiscordUser{ID: "333", GlobalName: "Caio"})
	require.NoError(t, err)
	require.Equal(t, int64(3), third.ID, "voltar com uma conta existente não gasta número")
}

func TestSignInDiscordRefreshesTheDiscordNames(t *testing.T) {
	store := newTestStore(t)
	ctx := t.Context()
	first, err := store.SignInDiscord(ctx, DiscordUser{ID: "111", Username: "ana", GlobalName: "Ana"})
	require.NoError(t, err)
	require.Equal(t, "ana", first.DiscordUsername)
	public := VisibilityPublic
	_, err = store.Update(ctx, first.ID, Changes{DiscordVisibility: &public})
	require.NoError(t, err)

	again, err := store.SignInDiscord(ctx, DiscordUser{ID: "111", Username: "ana.nova", GlobalName: "Aninha"})

	require.NoError(t, err)
	require.Equal(t, "ana.nova", again.DiscordUsername, "trocou o @ no Discord, troca aqui")
	require.Equal(t, "Aninha", again.DiscordGlobalName)
	require.Equal(t, "Ana", again.Nickname, "o apelido do juntos fica")
	require.Equal(t, VisibilityPublic, again.DiscordVisibility, "a escolha fica")
	found, err := store.ByDiscord(ctx, "111")
	require.NoError(t, err)
	require.Equal(t, first.ID, found.ID)
	_, err = store.ByDiscord(ctx, "999")
	require.ErrorIs(t, err, ErrNotFound)
}

func TestUpdateValidatesNicknameAvatarAndVisibility(t *testing.T) {
	ptr := func(s string) *string { return &s }
	tests := []struct {
		name    string
		changes Changes
		ok      bool
	}{
		{name: "avatar com acessório", changes: Changes{Avatar: ptr("fox.bowtie")}, ok: true},
		{name: "avatar sem acessório", changes: Changes{Avatar: ptr("red-panda")}, ok: true},
		{name: "avatar vazio volta ao padrão", changes: Changes{Avatar: ptr("")}, ok: true},
		{name: "avatar com maiúscula", changes: Changes{Avatar: ptr("Fox")}},
		{name: "avatar com três partes", changes: Changes{Avatar: ptr("fox.bow.tie")}},
		{name: "avatar que parece url", changes: Changes{Avatar: ptr("https://x.test/a.png")}},
		{name: "avatar longo demais", changes: Changes{Avatar: ptr(strings.Repeat("a", 30) + "." + strings.Repeat("b", 30))}},
		{name: "apelido em branco", changes: Changes{Nickname: ptr("   ")}},
		{name: "apelido com quebra de linha", changes: Changes{Nickname: ptr("a\nb")}},
		{name: "apelido novo", changes: Changes{Nickname: ptr("Ana Clara")}, ok: true},
		{name: "visibilidade pública", changes: Changes{Visibility: ptr(VisibilityPublic)}, ok: true},
		{name: "visibilidade inventada", changes: Changes{Visibility: ptr("everyone")}},
		{name: "discord público", changes: Changes{DiscordVisibility: ptr(VisibilityPublic)}, ok: true},
		{name: "discord só para amigos não existe", changes: Changes{DiscordVisibility: ptr(VisibilityFriends)}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := newTestStore(t)
			created, err := store.SignInDiscord(t.Context(), DiscordUser{ID: "111", GlobalName: "Ana"})
			require.NoError(t, err)

			updated, err := store.Update(t.Context(), created.ID, tt.changes)

			if !tt.ok {
				require.ErrorIs(t, err, ErrInvalid)
				return
			}
			require.NoError(t, err)
			stored, err := store.Get(t.Context(), created.ID)
			require.NoError(t, err)
			require.Equal(t, updated, stored)
		})
	}
}

func TestFriendship(t *testing.T) {
	store := newTestStore(t)
	ctx := t.Context()
	ana, _ := store.SignInDiscord(ctx, DiscordUser{ID: "1", GlobalName: "Ana"})
	bia, _ := store.SignInDiscord(ctx, DiscordUser{ID: "2", GlobalName: "Bia"})
	caio, _ := store.SignInDiscord(ctx, DiscordUser{ID: "3", GlobalName: "Caio"})

	state, err := store.RequestFriend(ctx, ana.ID, bia.ID)
	require.NoError(t, err)
	require.Equal(t, FriendRequested, state)
	friends, _ := store.Friends(ctx, ana.ID)
	require.Empty(t, friends, "pedido não é amizade")
	incoming, outgoing, err := store.FriendRequests(ctx, bia.ID)
	require.NoError(t, err)
	require.Equal(t, []int64{ana.ID}, incoming)
	require.Empty(t, outgoing)

	require.ErrorIs(t, store.AcceptFriend(ctx, caio.ID, ana.ID), ErrNoRequest, "só aceita quem recebeu o pedido")
	require.NoError(t, store.AcceptFriend(ctx, bia.ID, ana.ID))
	for _, pair := range [][2]int64{{ana.ID, bia.ID}, {bia.ID, ana.ID}} {
		friends, err := store.Friends(ctx, pair[0])
		require.NoError(t, err)
		require.Equal(t, []int64{pair[1]}, friends)
	}
	incoming, _, _ = store.FriendRequests(ctx, bia.ID)
	require.Empty(t, incoming, "pedido aceito sai da fila")

	// Two people asking each other are friends at the second ask.
	_, err = store.RequestFriend(ctx, caio.ID, ana.ID)
	require.NoError(t, err)
	state, err = store.RequestFriend(ctx, ana.ID, caio.ID)
	require.NoError(t, err)
	require.Equal(t, FriendAccepted, state)

	_, err = store.RequestFriend(ctx, ana.ID, ana.ID)
	require.ErrorIs(t, err, ErrInvalid)
	_, err = store.RequestFriend(ctx, ana.ID, 99)
	require.ErrorIs(t, err, ErrNotFound)

	require.NoError(t, store.RemoveFriend(ctx, bia.ID, ana.ID))
	friends, _ = store.Friends(ctx, ana.ID)
	require.Equal(t, []int64{caio.ID}, friends)
	friends, _ = store.Friends(ctx, bia.ID)
	require.Empty(t, friends)
}

func TestAskFriendSaysWhenTheAskIsNewAndDeclineKeepsFriendships(t *testing.T) {
	store := newTestStore(t)
	ctx := t.Context()
	ana, _ := store.SignInDiscord(ctx, DiscordUser{ID: "1", GlobalName: "Ana"})
	bia, _ := store.SignInDiscord(ctx, DiscordUser{ID: "2", GlobalName: "Bia"})

	_, fresh, err := store.AskFriend(ctx, ana.ID, bia.ID)
	require.NoError(t, err)
	require.True(t, fresh)
	_, fresh, err = store.AskFriend(ctx, ana.ID, bia.ID)
	require.NoError(t, err)
	require.False(t, fresh, "pedir de novo não é pedido novo")

	require.ErrorIs(t, store.DeclineFriend(ctx, ana.ID, bia.ID), ErrNoRequest, "quem pediu não recusa")
	require.NoError(t, store.DeclineFriend(ctx, bia.ID, ana.ID))
	incoming, _, _ := store.FriendRequests(ctx, bia.ID)
	require.Empty(t, incoming)
	_, outgoing, _ := store.FriendRequests(ctx, ana.ID)
	require.Empty(t, outgoing)

	_, _, err = store.AskFriend(ctx, ana.ID, bia.ID)
	require.NoError(t, err)
	require.NoError(t, store.AcceptFriend(ctx, bia.ID, ana.ID))
	require.ErrorIs(t, store.DeclineFriend(ctx, bia.ID, ana.ID), ErrNoRequest)
	friends, _ := store.AreFriends(ctx, ana.ID, bia.ID)
	require.True(t, friends, "recusar um pedido já aceito não desfaz a amizade")
}

func TestInvitesKeepTheNewestPerFriendAndExpire(t *testing.T) {
	store := newTestStore(t)
	ctx := t.Context()
	now := time.Date(2026, 10, 27, 20, 0, 0, 0, time.UTC)

	require.NoError(t, store.AddInvite(ctx, 1, RoomInvite{From: 2, RoomID: "OLDROOM1", At: now.Add(-2 * time.Minute)}))
	require.NoError(t, store.AddInvite(ctx, 1, RoomInvite{From: 2, RoomID: "NEWROOM1", At: now.Add(-time.Minute)}))
	require.NoError(t, store.AddInvite(ctx, 1, RoomInvite{From: 3, RoomID: "ROOM3333", At: now}))
	require.NoError(t, store.AddInvite(ctx, 1, RoomInvite{From: 4, RoomID: "STALE444", At: now.Add(-2 * InviteTTL)}))

	invites, err := store.Invites(ctx, 1, now)

	require.NoError(t, err)
	require.Equal(t, []RoomInvite{
		{From: 3, RoomID: "ROOM3333", At: now},
		{From: 2, RoomID: "NEWROOM1", At: now.Add(-time.Minute)},
	}, invites)
	require.NoError(t, store.DropInvite(ctx, 1, 3))
	invites, _ = store.Invites(ctx, 1, now)
	require.Len(t, invites, 1)
}

func TestRecordWatchKeepsNewestFirstAndCountsIt(t *testing.T) {
	store := newTestStore(t)
	ctx := t.Context()
	ana, _ := store.SignInDiscord(ctx, DiscordUser{ID: "1", GlobalName: "Ana"})
	start := time.Date(2026, 10, 1, 20, 0, 0, 0, time.UTC)

	require.NoError(t, store.RecordWatch(ctx, ana.ID, Watch{RoomID: "abc", Title: "Filme", Kind: "file", StartedAt: start, DurationSec: 3600, With: []int64{2}}))
	require.NoError(t, store.RecordWatch(ctx, ana.ID, Watch{RoomID: "abc", Title: "Outro", Kind: "youtube", StartedAt: start.Add(time.Hour), DurationSec: 1800}))

	history, err := store.History(ctx, ana.ID, 10)
	require.NoError(t, err)
	require.Len(t, history, 2)
	require.Equal(t, "Outro", history[0].Title)
	require.Equal(t, []int64{2}, history[1].With)
	stored, err := store.Get(ctx, ana.ID)
	require.NoError(t, err)
	require.Equal(t, int64(2), stored.Sessions)
	require.Equal(t, int64(5400), stored.WatchedSeconds)
}

func TestSessionsResolveToTheirAccountUntilEnded(t *testing.T) {
	store := newTestStore(t)
	ctx := t.Context()
	ana, _ := store.SignInDiscord(ctx, DiscordUser{ID: "1", GlobalName: "Ana"})

	token, err := store.StartSession(ctx, ana.ID)
	require.NoError(t, err)
	id, err := store.SessionAccount(ctx, token)
	require.NoError(t, err)
	require.Equal(t, ana.ID, id)

	require.NoError(t, store.EndSession(ctx, token))
	id, err = store.SessionAccount(ctx, token)
	require.NoError(t, err)
	require.Zero(t, id)
	id, err = store.SessionAccount(ctx, "inventado")
	require.NoError(t, err)
	require.Zero(t, id)
}

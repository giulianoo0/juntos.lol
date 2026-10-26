package httpapi

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/discord"
	"github.com/giulianoo0/ss/internal/room"
)

func TestDiscordRoomsAreRealRooms(t *testing.T) {
	store := newTestStore(t)
	rooms := discordRooms{store: store, cfg: testCfg(t)}

	created, err := rooms.CreateRoom(t.Context(), discord.NewRoom{Nickname: "Giuli", Name: "Sexta", Password: "pipoca"})
	require.NoError(t, err)
	require.Regexp(t, `^[A-Z0-9]{8}$`, created.ID)
	require.NotEmpty(t, created.OwnerToken)

	stored, err := store.Get(t.Context(), created.ID)
	require.NoError(t, err)
	require.Equal(t, created.OwnerToken, stored.OwnerToken)
	require.Equal(t, "m1", stored.ControllerID)
	require.True(t, stored.ExpiresAt.After(time.Now()))
	access, err := store.Access(t.Context(), created.ID)
	require.NoError(t, err)
	require.Equal(t, room.JoinPassword, access.Mode)
	require.True(t, room.VerifyPassword("pipoca", access.PasswordHash))
	members, err := store.Members(t.Context(), created.ID)
	require.NoError(t, err)
	require.Equal(t, "Giuli", members[0].Nickname)

	open, err := rooms.CreateRoom(t.Context(), discord.NewRoom{Nickname: "\x00"})
	require.NoError(t, err, "a Discord name the site would refuse becomes a random one")
	access, err = store.Access(t.Context(), open.ID)
	require.NoError(t, err)
	require.Equal(t, room.JoinOpen, access.Mode)

	card, err := rooms.Card(t.Context(), created.ID)
	require.NoError(t, err)
	require.Equal(t, discord.Card{Members: []string{"Giuli"}}, card)
}

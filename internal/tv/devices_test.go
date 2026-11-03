package tv

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/account"
	"github.com/giulianoo0/ss/internal/db/dbtest"
)

func newTestDevices(t *testing.T) (*Devices, int64, int64) {
	t.Helper()
	pool := dbtest.New(t)
	accounts := account.NewStore(pool)
	ana, err := accounts.SignInDiscord(t.Context(), account.DiscordUser{ID: "111", GlobalName: "Ana"})
	require.NoError(t, err)
	bia, err := accounts.SignInDiscord(t.Context(), account.DiscordUser{ID: "222", GlobalName: "Bia"})
	require.NoError(t, err)
	return NewDevices(pool), ana.ID, bia.ID
}

func TestDeviceIsFoundByItsTokenOnly(t *testing.T) {
	devices, ana, _ := newTestDevices(t)
	ctx := t.Context()

	created, token, err := devices.Create(ctx, ana, "Sala")
	require.NoError(t, err)
	found, err := devices.ByToken(ctx, token)

	require.NoError(t, err)
	require.Equal(t, created.ID, found.ID)
	require.Equal(t, ana, found.AccountID)
	require.Equal(t, "Sala", found.Name)
	_, err = devices.ByToken(ctx, token+"x")
	require.ErrorIs(t, err, ErrNotFound)
	_, err = devices.ByToken(ctx, "")
	require.ErrorIs(t, err, ErrNotFound)
}

func TestDeviceWithoutANameIsCalledTV(t *testing.T) {
	devices, ana, _ := newTestDevices(t)

	created, _, err := devices.Create(t.Context(), ana, "  ")

	require.NoError(t, err)
	require.Equal(t, "TV", created.Name)
}

func TestDevicesBelongToTheirAccount(t *testing.T) {
	devices, ana, bia := newTestDevices(t)
	ctx := t.Context()
	sala, _, err := devices.Create(ctx, ana, "Sala")
	require.NoError(t, err)
	_, _, err = devices.Create(ctx, bia, "Quarto")
	require.NoError(t, err)

	listed, err := devices.List(ctx, ana)
	require.NoError(t, err)
	require.Len(t, listed, 1)
	require.Equal(t, sala.ID, listed[0].ID)

	_, err = devices.Rename(ctx, bia, sala.ID, "Minha")
	require.ErrorIs(t, err, ErrNotFound, "outra conta não renomeia")
	require.ErrorIs(t, devices.Delete(ctx, bia, sala.ID), ErrNotFound, "outra conta não desvincula")
	_, err = devices.Get(ctx, ana, "not-a-uuid")
	require.ErrorIs(t, err, ErrNotFound)
}

func TestRenameAndDeleteADevice(t *testing.T) {
	devices, ana, _ := newTestDevices(t)
	ctx := t.Context()
	sala, token, err := devices.Create(ctx, ana, "Sala")
	require.NoError(t, err)

	renamed, err := devices.Rename(ctx, ana, sala.ID, "TV da sala")
	require.NoError(t, err)
	require.Equal(t, "TV da sala", renamed.Name)
	_, err = devices.Rename(ctx, ana, sala.ID, "")
	require.ErrorIs(t, err, ErrInvalidName)

	require.NoError(t, devices.Delete(ctx, ana, sala.ID))
	_, err = devices.ByToken(ctx, token)
	require.ErrorIs(t, err, ErrNotFound, "desvincular revoga o token")
}

func TestTouchMovesLastSeen(t *testing.T) {
	devices, ana, _ := newTestDevices(t)
	ctx := t.Context()
	sala, token, err := devices.Create(ctx, ana, "Sala")
	require.NoError(t, err)

	require.NoError(t, devices.Touch(ctx, sala.ID))
	found, err := devices.ByToken(ctx, token)

	require.NoError(t, err)
	require.True(t, found.LastSeenAt.After(sala.LastSeenAt))
}

func TestValidName(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
		ok    bool
	}{
		{name: "nome comum passa aparado", input: "  Sala ", want: "Sala", ok: true},
		{name: "vazio é recusado", input: "   ", ok: false},
		{name: "controle é recusado", input: "Sa\nla", ok: false},
		{name: "longo demais é recusado", input: "abcdefghijabcdefghijabcdefghijabcdefghijx", ok: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := cleanName(tt.input)
			require.Equal(t, tt.ok, ok)
			if tt.ok {
				require.Equal(t, tt.want, got)
			}
		})
	}
}

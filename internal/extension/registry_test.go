package extension

import (
	"fmt"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/account"
	"github.com/giulianoo0/ss/internal/db/dbtest"
)

func TestRegisterTakesAFreeIDOnce(t *testing.T) {
	pool := dbtest.New(t)
	registry := NewRegistry(pool)
	ctx := t.Context()
	accounts := account.NewStore(pool)
	ana, err := accounts.SignInDiscord(ctx, account.DiscordUser{ID: "1", GlobalName: "Ana"})
	require.NoError(t, err)
	bia, err := accounts.SignInDiscord(ctx, account.DiscordUser{ID: "2", GlobalName: "Bia"})
	require.NoError(t, err)

	entry, created, err := registry.Register(ctx, Registration{ID: "kiwi", Name: "Kiwi", Source: "github:ana/kiwi", Account: ana.ID})
	require.NoError(t, err)
	require.True(t, created)
	require.Equal(t, SubFor("kiwi"), entry.Sub)
	require.Equal(t, ana.ID, entry.CreatedBy)

	again, created, err := registry.Register(ctx, Registration{ID: "kiwi", Name: "Kiwi", Source: "github:ana/kiwi", Account: bia.ID})
	require.NoError(t, err, "a mesma fonte registrando de novo não é conflito")
	require.False(t, created)
	require.Equal(t, ana.ID, again.CreatedBy, "quem registrou primeiro continua sendo o autor")

	_, _, err = registry.Register(ctx, Registration{ID: "kiwi", Name: "Kiwi", Source: "github:bia/kiwi", Account: bia.ID})
	require.ErrorIs(t, err, ErrIDTaken)

	byID, err := registry.ByID(ctx, "kiwi")
	require.NoError(t, err)
	require.Equal(t, "github:ana/kiwi", byID.Source)
	require.Equal(t, ana.ID, byID.CreatedBy)
}

func TestUnknownSubIsNotFound(t *testing.T) {
	registry := NewRegistry(dbtest.New(t))

	_, err := registry.BySub(t.Context(), "aaaaaaaaaaaaaaaa")
	require.ErrorIs(t, err, ErrNotFound)
	_, err = registry.ByID(t.Context(), "nada")
	require.ErrorIs(t, err, ErrNotFound)
}

func TestTheMigrationStartsEmpty(t *testing.T) {
	var n int
	require.NoError(t, dbtest.New(t).QueryRow(t.Context(), "SELECT count(*) FROM extensions").Scan(&n))
	require.Zero(t, n)
}

func TestOnlyGitHubSourcesAreStored(t *testing.T) {
	registry := NewRegistry(dbtest.New(t))

	_, _, err := registry.Register(t.Context(), Registration{ID: "exemplo", Name: "Exemplo", Source: "juntos:exemplo"})
	require.Error(t, err)
}

// Two registrations racing for the same id: one source gets it, never both.
func TestRegisterRaceHasOneWinner(t *testing.T) {
	registry := NewRegistry(dbtest.New(t))
	ctx := t.Context()

	const racers = 8
	var wg sync.WaitGroup
	results := make([]error, racers)
	created := make([]bool, racers)
	for i := range racers {
		wg.Go(func() {
			_, created[i], results[i] = registry.Register(ctx, Registration{ID: "corrida", Name: "Corrida", Source: fmt.Sprintf("github:dono%d/corrida", i)})
		})
	}
	wg.Wait()

	winners := 0
	for i := range racers {
		if created[i] {
			winners++
			require.NoError(t, results[i])
		} else {
			require.ErrorIs(t, results[i], ErrIDTaken)
		}
	}
	require.Equal(t, 1, winners)
}

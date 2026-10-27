package db_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/db"
	"github.com/giulianoo0/ss/internal/db/dbtest"
)

func TestMigrateCreatesTheSchemaOnceAndRecordsIt(t *testing.T) {
	pool := dbtest.Fresh(t)
	ctx := t.Context()

	require.NoError(t, db.Migrate(ctx, pool))
	require.NoError(t, db.Migrate(ctx, pool), "rodar de novo no boot seguinte não faz nada")

	var applied int
	require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM schema_migrations").Scan(&applied))
	require.Equal(t, len(db.Migrations()), applied)
	for _, table := range []string{"accounts", "account_sessions", "friendships", "friend_requests", "watches", "room_invites", "workers"} {
		var exists bool
		require.NoError(t, pool.QueryRow(ctx, "SELECT to_regclass($1) IS NOT NULL", table).Scan(&exists))
		require.True(t, exists, table)
	}
}

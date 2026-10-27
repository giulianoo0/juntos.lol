package worker

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/db/dbtest"
)

func TestEnrollmentsKeepTheKeyUntilForgotten(t *testing.T) {
	adapters := map[string]func(t *testing.T) Enrollments{
		"memória":  func(*testing.T) Enrollments { return NewMemoryEnrollments() },
		"postgres": func(t *testing.T) Enrollments { return NewPGEnrollments(dbtest.New(t)) },
	}
	for name, open := range adapters {
		t.Run(name, func(t *testing.T) {
			enrollments := open(t)
			ctx := t.Context()

			require.NoError(t, enrollments.Enroll(ctx, "w_1", "pk1", "https://w1.test"))
			key, err := enrollments.PubKey(ctx, "w_1")
			require.NoError(t, err)
			require.Equal(t, "pk1", key)
			key, err = enrollments.PubKey(ctx, "w_desconhecido")
			require.NoError(t, err)
			require.Empty(t, key)

			require.NoError(t, enrollments.SetPublicBase(ctx, "w_1", "https://w1-novo.test"))
			require.NoError(t, enrollments.SetCertNotAfter(ctx, "w_1", 1_900_000_000))
			require.NoError(t, enrollments.Forget(ctx, "w_1"))
			key, err = enrollments.PubKey(ctx, "w_1")
			require.NoError(t, err)
			require.Empty(t, key, "esquecido precisa se matricular de novo")
		})
	}
}

func TestPGEnrollmentsRecordWhereAndUntilWhen(t *testing.T) {
	pool := dbtest.New(t)
	enrollments := NewPGEnrollments(pool)
	ctx := t.Context()
	before := time.Now().Add(-time.Second)

	require.NoError(t, enrollments.Enroll(ctx, "w_1", "pk1", "https://w1.test"))
	require.NoError(t, enrollments.SetPublicBase(ctx, "w_1", "https://w1-novo.test"))
	require.NoError(t, enrollments.SetCertNotAfter(ctx, "w_1", 1_900_000_000))

	var base string
	var notAfter int64
	var enrolledAt time.Time
	require.NoError(t, pool.QueryRow(ctx, "SELECT public_base, cert_not_after, enrolled_at FROM workers WHERE id = 'w_1'").
		Scan(&base, &notAfter, &enrolledAt))
	require.Equal(t, "https://w1-novo.test", base)
	require.Equal(t, int64(1_900_000_000), notAfter)
	require.True(t, enrolledAt.After(before))
}

func TestCullForgetsTheEnrollmentOfAGhost(t *testing.T) {
	enrollments := NewMemoryEnrollments()
	r := NewRegistry(newRedisClient(t), enrollments)
	ctx := t.Context()
	require.NoError(t, r.Enroll(ctx, "w_ghost", "pk", "https://ghost.test"))
	l := &link{}
	r.Attach(ctx, "w_ghost", "pk", "https://ghost.test", l)
	r.Detach("w_ghost", l)

	r.Cull(ctx, time.Now().Add(time.Hour), time.Minute)

	key, err := r.PubKey(ctx, "w_ghost")
	require.NoError(t, err)
	require.Empty(t, key)
}

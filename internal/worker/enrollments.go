package worker

import (
	"context"
	"errors"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Enrollments keeps who is enrolled and with which key: the one fact about a
// worker that must outlive a restart.
type Enrollments interface {
	Enroll(ctx context.Context, id, pubkey, publicBase string) error
	// PubKey answers an enrolled worker's key, "" when unknown.
	PubKey(ctx context.Context, id string) (string, error)
	SetPublicBase(ctx context.Context, id, publicBase string) error
	SetCertNotAfter(ctx context.Context, id string, notAfter int64) error
	// Forget drops the enrollment; the worker has to enroll again.
	Forget(ctx context.Context, id string) error
}

type pgEnrollments struct{ pool *pgxpool.Pool }

func NewPGEnrollments(pool *pgxpool.Pool) Enrollments { return pgEnrollments{pool: pool} }

func (e pgEnrollments) Enroll(ctx context.Context, id, pubkey, publicBase string) error {
	_, err := e.pool.Exec(ctx, `INSERT INTO workers (id, pubkey, public_base) VALUES ($1, $2, $3)
		ON CONFLICT (id) DO UPDATE SET pubkey = excluded.pubkey, public_base = excluded.public_base, enrolled_at = now()`,
		id, pubkey, publicBase)
	return err
}

func (e pgEnrollments) PubKey(ctx context.Context, id string) (string, error) {
	var key string
	err := e.pool.QueryRow(ctx, "SELECT pubkey FROM workers WHERE id = $1", id).Scan(&key)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return key, err
}

func (e pgEnrollments) SetPublicBase(ctx context.Context, id, publicBase string) error {
	_, err := e.pool.Exec(ctx, "UPDATE workers SET public_base = $2 WHERE id = $1", id, publicBase)
	return err
}

func (e pgEnrollments) SetCertNotAfter(ctx context.Context, id string, notAfter int64) error {
	_, err := e.pool.Exec(ctx, "UPDATE workers SET cert_not_after = $2 WHERE id = $1", id, notAfter)
	return err
}

func (e pgEnrollments) Forget(ctx context.Context, id string) error {
	_, err := e.pool.Exec(ctx, "DELETE FROM workers WHERE id = $1", id)
	return err
}

// memoryEnrollments forgets everything on restart: for tests.
type memoryEnrollments struct {
	mu   sync.Mutex
	keys map[string]string
}

func NewMemoryEnrollments() Enrollments { return &memoryEnrollments{keys: map[string]string{}} }

func (e *memoryEnrollments) Enroll(_ context.Context, id, pubkey, _ string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.keys[id] = pubkey
	return nil
}

func (e *memoryEnrollments) PubKey(_ context.Context, id string) (string, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.keys[id], nil
}

func (e *memoryEnrollments) SetPublicBase(context.Context, string, string) error { return nil }

func (e *memoryEnrollments) SetCertNotAfter(context.Context, string, int64) error { return nil }

func (e *memoryEnrollments) Forget(_ context.Context, id string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	delete(e.keys, id)
	return nil
}

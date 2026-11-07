package extension

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrNotFound = errors.New("extension not found")
	ErrIDTaken  = errors.New("extension id taken")
)

// Entry is one registered extension. Source is "github:<owner>/<repo>", a
// public repository with a license.
type Entry struct {
	ID        string
	Sub       string
	Source    string
	Name      string
	Icon      string
	CreatedAt time.Time
	// CreatedBy is the account that registered it, 0 for the seeded ones.
	CreatedBy int64
}

type Registration struct {
	ID      string
	Name    string
	Source  string
	Icon    string
	Account int64
}

type Registry struct {
	pool *pgxpool.Pool
}

func NewRegistry(pool *pgxpool.Pool) *Registry { return &Registry{pool: pool} }

const entryColumns = "id, sub, source, name, coalesce(icon, ''), created_at, coalesce(created_by_account, 0)"

func scanEntry(row pgx.Row) (Entry, error) {
	var e Entry
	err := row.Scan(&e.ID, &e.Sub, &e.Source, &e.Name, &e.Icon, &e.CreatedAt, &e.CreatedBy)
	if errors.Is(err, pgx.ErrNoRows) {
		return Entry{}, ErrNotFound
	}
	return e, err
}

// Register gives the id to the source when nobody has it. The same source
// asking again gets its entry back with created false; another source gets
// ErrIDTaken.
func (r *Registry) Register(ctx context.Context, reg Registration) (Entry, bool, error) {
	var icon *string
	if reg.Icon != "" {
		icon = &reg.Icon
	}
	var by *int64
	if reg.Account != 0 {
		by = &reg.Account
	}
	entry, err := scanEntry(r.pool.QueryRow(ctx, `INSERT INTO extensions (id, source, sub, name, icon, created_by_account)
		VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING `+entryColumns,
		reg.ID, reg.Source, SubFor(reg.ID), reg.Name, icon, by))
	if err == nil {
		return entry, true, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return Entry{}, false, err
	}
	existing, err := r.ByID(ctx, reg.ID)
	if errors.Is(err, ErrNotFound) {
		// The sub, not the id, collided.
		return Entry{}, false, ErrIDTaken
	}
	if err != nil {
		return Entry{}, false, err
	}
	if existing.Source != reg.Source {
		return Entry{}, false, ErrIDTaken
	}
	return existing, false, nil
}

func (r *Registry) ByID(ctx context.Context, id string) (Entry, error) {
	return scanEntry(r.pool.QueryRow(ctx, "SELECT "+entryColumns+" FROM extensions WHERE id = $1", id))
}

func (r *Registry) BySub(ctx context.Context, sub string) (Entry, error) {
	return scanEntry(r.pool.QueryRow(ctx, "SELECT "+entryColumns+" FROM extensions WHERE sub = $1", sub))
}

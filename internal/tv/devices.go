// Package tv keeps the TVs linked to an account: the device rows, the
// pairing that links one, and how each TV mixes the room's sound.
package tv

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	tokenBytes   = 32
	maxNameRunes = 40
	defaultName  = "TV"
)

var (
	ErrNotFound    = errors.New("tv not found")
	ErrInvalidName = errors.New("invalid tv name")
)

type Device struct {
	ID         string
	AccountID  int64
	Name       string
	CreatedAt  time.Time
	LastSeenAt time.Time
}

type Devices struct {
	pool *pgxpool.Pool
}

func NewDevices(pool *pgxpool.Pool) *Devices { return &Devices{pool: pool} }

const deviceColumns = "id::text, account_id, name, created_at, last_seen_at"

func scanDevice(row pgx.Row) (Device, error) {
	var d Device
	err := row.Scan(&d.ID, &d.AccountID, &d.Name, &d.CreatedAt, &d.LastSeenAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Device{}, ErrNotFound
	}
	return d, err
}

func hashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// Create links a TV to the account. The token it returns is the only key to
// the device and is never kept.
func (d *Devices) Create(ctx context.Context, accountID int64, name string) (Device, string, error) {
	cleaned, ok := cleanName(name)
	if !ok {
		cleaned = defaultName
	}
	raw := make([]byte, tokenBytes)
	if _, err := rand.Read(raw); err != nil {
		return Device{}, "", err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	device, err := scanDevice(d.pool.QueryRow(ctx, `INSERT INTO tv_devices (account_id, name, token_hash)
		VALUES ($1, $2, $3) RETURNING `+deviceColumns, accountID, cleaned, hashToken(token)))
	return device, token, err
}

func (d *Devices) List(ctx context.Context, accountID int64) ([]Device, error) {
	rows, err := d.pool.Query(ctx, "SELECT "+deviceColumns+" FROM tv_devices WHERE account_id = $1 ORDER BY created_at, id", accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	devices := []Device{}
	for rows.Next() {
		device, err := scanDevice(rows)
		if err != nil {
			return nil, err
		}
		devices = append(devices, device)
	}
	return devices, rows.Err()
}

// Get is one of the account's TVs; anyone else's is not found.
func (d *Devices) Get(ctx context.Context, accountID int64, id string) (Device, error) {
	device, err := scanDevice(d.pool.QueryRow(ctx, "SELECT "+deviceColumns+" FROM tv_devices WHERE id = $1 AND account_id = $2", id, accountID))
	return device, notFoundOnBadID(err)
}

func (d *Devices) Rename(ctx context.Context, accountID int64, id, name string) (Device, error) {
	cleaned, ok := cleanName(name)
	if !ok {
		return Device{}, ErrInvalidName
	}
	device, err := scanDevice(d.pool.QueryRow(ctx, `UPDATE tv_devices SET name = $3
		WHERE id = $1 AND account_id = $2 RETURNING `+deviceColumns, id, accountID, cleaned))
	return device, notFoundOnBadID(err)
}

func (d *Devices) Delete(ctx context.Context, accountID int64, id string) error {
	tag, err := d.pool.Exec(ctx, "DELETE FROM tv_devices WHERE id = $1 AND account_id = $2", id, accountID)
	if err = notFoundOnBadID(err); err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ByToken is the TV a token signs in as; a revoked token finds nothing.
func (d *Devices) ByToken(ctx context.Context, token string) (Device, error) {
	if token == "" || len(token) > 2*tokenBytes {
		return Device{}, ErrNotFound
	}
	return scanDevice(d.pool.QueryRow(ctx, "SELECT "+deviceColumns+" FROM tv_devices WHERE token_hash = $1", hashToken(token)))
}

func (d *Devices) Touch(ctx context.Context, id string) error {
	_, err := d.pool.Exec(ctx, "UPDATE tv_devices SET last_seen_at = now() WHERE id = $1", id)
	return notFoundOnBadID(err)
}

// notFoundOnBadID turns an id that is not even a uuid into a missing device.
func notFoundOnBadID(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "22P02" {
		return ErrNotFound
	}
	return err
}

func cleanName(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if value == "" || !utf8.ValidString(value) || utf8.RuneCountInString(value) > maxNameRunes {
		return "", false
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return "", false
		}
	}
	return value, true
}

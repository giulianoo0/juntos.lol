// Package dm keeps private messages between two accounts. The server never
// sees a message in the clear: each device holds a P-256 key pair, and a
// message travels as AES-GCM ciphertext with its key wrapped once for every
// device of both accounts. The store routes and keeps; it cannot read.
package dm

import (
	"context"
	"crypto/ecdh"
	"encoding/base64"
	"encoding/json"
	"errors"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// MaxDevices is how many devices an account keeps keys for; a new one
	// past it pushes out the one seen longest ago.
	MaxDevices = 8
	// maxBody is the ciphertext of about 4000 characters of text.
	maxBody    = 24 << 10
	maxLabel   = 40
	maxClient  = 64
	PageSize   = 50
	maxThreads = 100
)

var (
	ErrInvalid  = errors.New("invalid message")
	ErrNoDevice = errors.New("unknown device")

	ivRe     = regexp.MustCompile(`^[A-Za-z0-9_-]{16}$`)
	b64Re    = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	clientRe = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)
)

// StaleDevicesError is a send whose keys don't match the devices both
// accounts have now; the sender wraps again for Devices.
type StaleDevicesError struct {
	Devices map[int64][]Device
}

func (e *StaleDevicesError) Error() string { return "stale devices" }

// Device is one device's public key.
type Device struct {
	ID        string    `json:"id"`
	AccountID int64     `json:"accountId"`
	PublicKey string    `json:"publicKey"`
	Label     string    `json:"label,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

// WrappedKey is the message key sealed for one device.
type WrappedKey struct {
	IV  string `json:"iv"`
	Key string `json:"key"`
}

// Outgoing is a message as its sender hands it over.
type Outgoing struct {
	From         int64
	To           int64
	SenderDevice string
	ClientID     string
	IV           string
	Body         string
	Keys         map[string]WrappedKey
}

// Message is a message as one device reads it: only its own wrapped key.
type Message struct {
	ID           int64       `json:"id"`
	From         int64       `json:"from"`
	To           int64       `json:"to"`
	SenderDevice string      `json:"senderDevice"`
	ClientID     string      `json:"clientId"`
	IV           string      `json:"iv"`
	Body         string      `json:"body"`
	Key          *WrappedKey `json:"key,omitempty"`
	At           time.Time   `json:"at"`
}

// Thread is a conversation as the list shows it.
type Thread struct {
	Other  int64    `json:"other"`
	Last   *Message `json:"last,omitempty"`
	Unread int      `json:"unread"`
	// TheyRead is how far the other account read.
	TheyRead int64 `json:"theyRead"`
}

type Store struct {
	pool *pgxpool.Pool
}

func NewStore(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

func pair(x, y int64) (int64, int64) {
	if x < y {
		return x, y
	}
	return y, x
}

// ValidPublicKey is a P-256 point, uncompressed, in base64url.
func ValidPublicKey(key string) bool {
	raw, err := base64.RawURLEncoding.DecodeString(key)
	if err != nil || len(raw) != 65 {
		return false
	}
	_, err = ecdh.P256().NewPublicKey(raw)
	return err == nil
}

func cleanLabel(label string) string {
	label = strings.TrimSpace(strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, label))
	if len([]rune(label)) > maxLabel {
		label = string([]rune(label)[:maxLabel])
	}
	return label
}

// RegisterDevice keeps a device's public key. The same key registered again
// answers the device it already is.
func (s *Store) RegisterDevice(ctx context.Context, accountID int64, publicKey, label string) (Device, error) {
	if !ValidPublicKey(publicKey) {
		return Device{}, ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Device{}, err
	}
	defer tx.Rollback(ctx)
	var d Device
	err = tx.QueryRow(ctx, `SELECT id::text, account_id, public_key, label, created_at FROM dm_devices
		WHERE account_id = $1 AND public_key = $2`, accountID, publicKey).
		Scan(&d.ID, &d.AccountID, &d.PublicKey, &d.Label, &d.CreatedAt)
	if err == nil {
		_, err = tx.Exec(ctx, "UPDATE dm_devices SET seen_at = now() WHERE id = $1", d.ID)
		if err != nil {
			return Device{}, err
		}
		return d, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Device{}, err
	}
	err = tx.QueryRow(ctx, `INSERT INTO dm_devices (account_id, public_key, label) VALUES ($1, $2, $3)
		RETURNING id::text, account_id, public_key, label, created_at`, accountID, publicKey, cleanLabel(label)).
		Scan(&d.ID, &d.AccountID, &d.PublicKey, &d.Label, &d.CreatedAt)
	if err != nil {
		return Device{}, err
	}
	_, err = tx.Exec(ctx, `DELETE FROM dm_devices WHERE account_id = $1 AND id NOT IN
		(SELECT id FROM dm_devices WHERE account_id = $1 ORDER BY seen_at DESC LIMIT $2)`, accountID, MaxDevices)
	if err != nil {
		return Device{}, err
	}
	d.CreatedAt = d.CreatedAt.UTC()
	return d, tx.Commit(ctx)
}

// Owns says whether the device is the account's, and marks it seen.
func (s *Store) Owns(ctx context.Context, accountID int64, deviceID string) (bool, error) {
	if !validUUID(deviceID) {
		return false, nil
	}
	tag, err := s.pool.Exec(ctx, "UPDATE dm_devices SET seen_at = now() WHERE id = $1 AND account_id = $2", deviceID, accountID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

func (s *Store) RemoveDevice(ctx context.Context, accountID int64, deviceID string) error {
	if !validUUID(deviceID) {
		return nil
	}
	_, err := s.pool.Exec(ctx, "DELETE FROM dm_devices WHERE id = $1 AND account_id = $2", deviceID, accountID)
	return err
}

var uuidRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func validUUID(id string) bool { return uuidRe.MatchString(id) }

// Devices is every device of each account, oldest first.
func (s *Store) Devices(ctx context.Context, accountIDs ...int64) (map[int64][]Device, error) {
	rows, err := s.pool.Query(ctx, `SELECT id::text, account_id, public_key, label, created_at FROM dm_devices
		WHERE account_id = ANY($1) ORDER BY created_at, id`, accountIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[int64][]Device, len(accountIDs))
	for _, id := range accountIDs {
		out[id] = []Device{}
	}
	for rows.Next() {
		var d Device
		if err := rows.Scan(&d.ID, &d.AccountID, &d.PublicKey, &d.Label, &d.CreatedAt); err != nil {
			return nil, err
		}
		d.CreatedAt = d.CreatedAt.UTC()
		out[d.AccountID] = append(out[d.AccountID], d)
	}
	return out, rows.Err()
}

func validOutgoing(m Outgoing) bool {
	if m.From <= 0 || m.To <= 0 || m.From == m.To || !validUUID(m.SenderDevice) || !clientRe.MatchString(m.ClientID) {
		return false
	}
	if !ivRe.MatchString(m.IV) || len(m.Body) == 0 || len(m.Body) > maxBody || !b64Re.MatchString(m.Body) {
		return false
	}
	if len(m.Keys) == 0 || len(m.Keys) > 2*MaxDevices {
		return false
	}
	for id, key := range m.Keys {
		// 32 bytes of key and 16 of tag, in base64url.
		if !validUUID(id) || !ivRe.MatchString(key.IV) || len(key.Key) != 64 || !b64Re.MatchString(key.Key) {
			return false
		}
	}
	return true
}

// Send keeps a message whose key was wrapped for exactly the devices both
// accounts have now. The same client id sent twice keeps one message.
func (s *Store) Send(ctx context.Context, m Outgoing) (Message, error) {
	if !validOutgoing(m) {
		return Message{}, ErrInvalid
	}
	devices, err := s.Devices(ctx, m.From, m.To)
	if err != nil {
		return Message{}, err
	}
	want := map[string]bool{}
	senderKnown := false
	for _, list := range devices {
		for _, d := range list {
			want[d.ID] = true
			if d.ID == m.SenderDevice && d.AccountID == m.From {
				senderKnown = true
			}
		}
	}
	if !senderKnown {
		return Message{}, ErrNoDevice
	}
	same := len(want) == len(m.Keys)
	for id := range m.Keys {
		if !want[id] {
			same = false
		}
	}
	if !same {
		return Message{}, &StaleDevicesError{Devices: devices}
	}
	keys, err := json.Marshal(m.Keys)
	if err != nil {
		return Message{}, err
	}
	a, b := pair(m.From, m.To)
	var out Message
	err = s.pool.QueryRow(ctx, `INSERT INTO dm_messages (a, b, sender, sender_device, client_id, iv, body, keys)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (sender, client_id) DO UPDATE SET client_id = EXCLUDED.client_id
		RETURNING id, at`, a, b, m.From, m.SenderDevice, m.ClientID, m.IV, m.Body, keys).Scan(&out.ID, &out.At)
	if err != nil {
		return Message{}, err
	}
	out.From, out.To, out.SenderDevice, out.ClientID, out.IV, out.Body = m.From, m.To, m.SenderDevice, m.ClientID, m.IV, m.Body
	out.At = out.At.UTC()
	return out, nil
}

// For is the message as one device reads it.
func For(m Message, keys map[string]WrappedKey, device string) Message {
	if key, ok := keys[device]; ok {
		m.Key = &key
	}
	return m
}

func scanMessage(row pgx.Row, device string) (Message, error) {
	var m Message
	var a, b int64
	var raw []byte
	if err := row.Scan(&m.ID, &a, &b, &m.From, &m.SenderDevice, &m.ClientID, &m.IV, &m.Body, &raw, &m.At); err != nil {
		return Message{}, err
	}
	m.To = a
	if m.From == a {
		m.To = b
	}
	m.At = m.At.UTC()
	var keys map[string]WrappedKey
	if err := json.Unmarshal(raw, &keys); err != nil {
		return Message{}, err
	}
	return For(m, keys, device), nil
}

const messageColumns = `id, a, b, sender, sender_device::text, client_id, iv, body, keys, at`

// Page is the conversation between me and other, newest first, before the
// message id given (0 for the newest), as device reads it.
func (s *Store) Page(ctx context.Context, me, other int64, device string, before int64, limit int) ([]Message, error) {
	if limit <= 0 || limit > PageSize {
		limit = PageSize
	}
	if before <= 0 {
		before = 1<<63 - 1
	}
	a, b := pair(me, other)
	rows, err := s.pool.Query(ctx, `SELECT `+messageColumns+` FROM dm_messages
		WHERE a = $1 AND b = $2 AND id < $3 ORDER BY id DESC LIMIT $4`, a, b, before, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Message{}
	for rows.Next() {
		m, err := scanMessage(rows, device)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// Since is every message to or from me after id, oldest first: what a
// device missed while it was away.
func (s *Store) Since(ctx context.Context, me int64, device string, after int64) ([]Message, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+messageColumns+` FROM dm_messages
		WHERE (a = $1 OR b = $1) AND id > $2 ORDER BY id LIMIT 500`, me, after)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Message{}
	for rows.Next() {
		m, err := scanMessage(rows, device)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// Threads is every conversation of me, the most recent first.
func (s *Store) Threads(ctx context.Context, me int64, device string) ([]Thread, error) {
	rows, err := s.pool.Query(ctx, `SELECT DISTINCT ON (a, b) `+messageColumns+` FROM dm_messages
		WHERE a = $1 OR b = $1 ORDER BY a, b, id DESC`, me)
	if err != nil {
		return nil, err
	}
	var threads []Thread
	for rows.Next() {
		m, err := scanMessage(rows, device)
		if err != nil {
			rows.Close()
			return nil, err
		}
		other := m.To
		if m.To == me {
			other = m.From
		}
		last := m
		threads = append(threads, Thread{Other: other, Last: &last})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	slices.SortFunc(threads, func(x, y Thread) int {
		switch {
		case x.Last.ID > y.Last.ID:
			return -1
		case x.Last.ID < y.Last.ID:
			return 1
		}
		return 0
	})
	if len(threads) > maxThreads {
		threads = threads[:maxThreads]
	}
	for i := range threads {
		other := threads[i].Other
		a, b := pair(me, other)
		err := s.pool.QueryRow(ctx, `SELECT
			(SELECT count(*) FROM dm_messages WHERE a = $1 AND b = $2 AND sender = $4
				AND id > COALESCE((SELECT up_to FROM dm_reads WHERE account_id = $3 AND other_id = $4), 0)),
			COALESCE((SELECT up_to FROM dm_reads WHERE account_id = $4 AND other_id = $3), 0)`,
			a, b, me, other).Scan(&threads[i].Unread, &threads[i].TheyRead)
		if err != nil {
			return nil, err
		}
	}
	if threads == nil {
		threads = []Thread{}
	}
	return threads, nil
}

// TheyRead is how far other read the conversation with me.
func (s *Store) TheyRead(ctx context.Context, me, other int64) (int64, error) {
	var upTo int64
	err := s.pool.QueryRow(ctx, "SELECT COALESCE((SELECT up_to FROM dm_reads WHERE account_id = $1 AND other_id = $2), 0)", other, me).Scan(&upTo)
	return upTo, err
}

// MarkRead moves how far me read other's messages; it never goes back.
func (s *Store) MarkRead(ctx context.Context, me, other, upTo int64) (int64, error) {
	var kept int64
	err := s.pool.QueryRow(ctx, `INSERT INTO dm_reads (account_id, other_id, up_to) VALUES ($1, $2, $3)
		ON CONFLICT (account_id, other_id) DO UPDATE SET up_to = GREATEST(dm_reads.up_to, EXCLUDED.up_to)
		RETURNING up_to`, me, other, upTo).Scan(&kept)
	return kept, err
}

// Package account keeps the people who signed in with Discord: their number,
// how they show up, their friends and what they watched.
package account

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	VisibilityPublic  = "public"
	VisibilityFriends = "friends"
	VisibilityPrivate = "private"

	maxNicknameRunes = 32
	maxAvatarBytes   = 48
	// historyKept is how many watches an account keeps, newest first.
	historyKept = 200
	sessionTTL  = 30 * 24 * time.Hour
	// InviteTTL is how long a call into a room waits to be answered.
	InviteTTL  = time.Hour
	sessionLen = 32
)

var (
	ErrNotFound  = errors.New("account not found")
	ErrInvalid   = errors.New("invalid account change")
	ErrNoRequest = errors.New("no friend request")

	avatarRe = regexp.MustCompile(`^[a-z0-9-]+(\.[a-z0-9-]+)?$`)
)

// Account is one person. DiscordID never leaves the server; the Discord
// names are shown only as DiscordVisibility allows.
type Account struct {
	ID                int64  `json:"id"`
	DiscordID         string `json:"-"`
	DiscordUsername   string `json:"-"`
	DiscordGlobalName string `json:"-"`
	// DiscordVisibility is public or private; private when never chosen.
	DiscordVisibility string    `json:"-"`
	Nickname          string    `json:"nickname"`
	Avatar            string    `json:"avatar"`
	Visibility        string    `json:"visibility"`
	CreatedAt         time.Time `json:"createdAt"`
	Sessions          int64     `json:"-"`
	WatchedSeconds    int64     `json:"-"`
}

// Changes is a PATCH of an account; nil fields stay as they are. An empty
// avatar goes back to the default one.
type Changes struct {
	Nickname   *string `json:"nickname"`
	Avatar     *string `json:"avatar"`
	Visibility *string `json:"visibility"`
	// DiscordVisibility is public or private.
	DiscordVisibility *string `json:"discordVisibility"`
}

// DiscordUser is who Discord says signed in.
type DiscordUser struct {
	ID         string
	Username   string
	GlobalName string
}

func (u DiscordUser) displayName() string {
	if strings.TrimSpace(u.GlobalName) != "" {
		return u.GlobalName
	}
	return u.Username
}

// Watch is one stretch of a member in a room in front of one media.
type Watch struct {
	RoomID      string    `json:"roomId"`
	Title       string    `json:"title"`
	Kind        string    `json:"kind"`
	StartedAt   time.Time `json:"startedAt"`
	DurationSec int64     `json:"durationSec"`
	// With are the other accounts that were in the room meanwhile.
	With []int64 `json:"with,omitempty"`
}

type FriendState string

const (
	FriendRequested FriendState = "requested"
	FriendAccepted  FriendState = "friends"
)

type Store struct {
	pool *pgxpool.Pool
}

func NewStore(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

const accountColumns = `id, discord_id, nickname, avatar, visibility, discord_username,
	discord_global_name, discord_public, created_at, sessions, watched_seconds`

func scanAccount(row pgx.Row) (Account, error) {
	var a Account
	var discordPublic bool
	err := row.Scan(&a.ID, &a.DiscordID, &a.Nickname, &a.Avatar, &a.Visibility, &a.DiscordUsername,
		&a.DiscordGlobalName, &discordPublic, &a.CreatedAt, &a.Sessions, &a.WatchedSeconds)
	if errors.Is(err, pgx.ErrNoRows) {
		return Account{}, ErrNotFound
	}
	if err != nil {
		return Account{}, err
	}
	a.CreatedAt = a.CreatedAt.UTC()
	a.DiscordVisibility = VisibilityPrivate
	if discordPublic {
		a.DiscordVisibility = VisibilityPublic
	}
	return a, nil
}

// SignInDiscord finds the account behind a Discord user, or opens the next
// numbered one named after them. Coming back never spends a number, and
// refreshes the Discord names kept with the account.
func (s *Store) SignInDiscord(ctx context.Context, user DiscordUser) (Account, error) {
	if user.ID == "" {
		return Account{}, ErrInvalid
	}
	username, globalName := cleanDiscordName(user.Username), cleanDiscordName(user.GlobalName)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Account{}, err
	}
	defer tx.Rollback(ctx)
	// Two sign-ins of the same person wait on each other here, so the second
	// finds the first's account instead of spending a number.
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", user.ID); err != nil {
		return Account{}, err
	}
	found, err := scanAccount(tx.QueryRow(ctx, `UPDATE accounts SET discord_username = $2, discord_global_name = $3
		WHERE discord_id = $1 RETURNING `+accountColumns, user.ID, username, globalName))
	if err == nil {
		return found, tx.Commit(ctx)
	}
	if !errors.Is(err, ErrNotFound) {
		return Account{}, err
	}
	var id int64
	if err := tx.QueryRow(ctx, "SELECT nextval(pg_get_serial_sequence('accounts', 'id'))").Scan(&id); err != nil {
		return Account{}, err
	}
	nickname := cleanNickname(user.displayName())
	if nickname == "" {
		nickname = "#" + strconv.FormatInt(id, 10)
	}
	created, err := scanAccount(tx.QueryRow(ctx, `INSERT INTO accounts
		(id, discord_id, nickname, visibility, discord_username, discord_global_name, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING `+accountColumns,
		id, user.ID, nickname, VisibilityPrivate, username, globalName, time.Now().UTC().Truncate(time.Second)))
	if err != nil {
		return Account{}, err
	}
	return created, tx.Commit(ctx)
}

// ByDiscord is the account a Discord user signed in as, or ErrNotFound.
func (s *Store) ByDiscord(ctx context.Context, discordID string) (Account, error) {
	return scanAccount(s.pool.QueryRow(ctx, "SELECT "+accountColumns+" FROM accounts WHERE discord_id = $1", discordID))
}

func (s *Store) Get(ctx context.Context, id int64) (Account, error) {
	return scanAccount(s.pool.QueryRow(ctx, "SELECT "+accountColumns+" FROM accounts WHERE id = $1", id))
}

func (s *Store) Update(ctx context.Context, id int64, changes Changes) (Account, error) {
	var nickname *string
	if changes.Nickname != nil {
		trimmed := strings.TrimSpace(*changes.Nickname)
		if !validNickname(trimmed) {
			return Account{}, ErrInvalid
		}
		nickname = &trimmed
	}
	if changes.Avatar != nil && *changes.Avatar != "" && !ValidAvatar(*changes.Avatar) {
		return Account{}, ErrInvalid
	}
	if changes.Visibility != nil {
		switch *changes.Visibility {
		case VisibilityPublic, VisibilityFriends, VisibilityPrivate:
		default:
			return Account{}, ErrInvalid
		}
	}
	var discordPublic *bool
	if changes.DiscordVisibility != nil {
		switch *changes.DiscordVisibility {
		case VisibilityPublic, VisibilityPrivate:
		default:
			return Account{}, ErrInvalid
		}
		public := *changes.DiscordVisibility == VisibilityPublic
		discordPublic = &public
	}
	return scanAccount(s.pool.QueryRow(ctx, `UPDATE accounts SET
		nickname = COALESCE($2, nickname), avatar = COALESCE($3, avatar),
		visibility = COALESCE($4, visibility), discord_public = COALESCE($5, discord_public)
		WHERE id = $1 RETURNING `+accountColumns, id, nickname, changes.Avatar, changes.Visibility, discordPublic))
}

func hashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// StartSession opens a sign-in for the cookie; the token is the only key to
// it, and only its hash is kept.
func (s *Store) StartSession(ctx context.Context, id int64) (string, error) {
	raw := make([]byte, sessionLen)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	token := hex.EncodeToString(raw)
	if _, err := s.pool.Exec(ctx, "DELETE FROM account_sessions WHERE expires_at < now()"); err != nil {
		return "", err
	}
	if _, err := s.pool.Exec(ctx, "INSERT INTO account_sessions (token_hash, account_id, expires_at) VALUES ($1, $2, $3)",
		hashToken(token), id, time.Now().Add(sessionTTL)); err != nil {
		return "", err
	}
	return token, nil
}

// SessionAccount is the account a cookie signs in as, or 0 for none. Every
// use pushes the expiry back.
func (s *Store) SessionAccount(ctx context.Context, token string) (int64, error) {
	if len(token) != sessionLen*2 {
		return 0, nil
	}
	var id int64
	var expiresAt time.Time
	hash := hashToken(token)
	err := s.pool.QueryRow(ctx, `SELECT account_id, expires_at FROM account_sessions
		WHERE token_hash = $1 AND expires_at > now()`, hash).Scan(&id, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	// Sliding expiry, written at most once a day rather than on every request.
	if renewed := time.Now().Add(sessionTTL); renewed.Sub(expiresAt) > 24*time.Hour {
		if _, err := s.pool.Exec(ctx, "UPDATE account_sessions SET expires_at = $2 WHERE token_hash = $1", hash, renewed); err != nil {
			return 0, err
		}
	}
	return id, nil
}

func (s *Store) EndSession(ctx context.Context, token string) error {
	_, err := s.pool.Exec(ctx, "DELETE FROM account_sessions WHERE token_hash = $1", hashToken(token))
	return err
}

// pair orders a friendship's two ids the way its row keeps them.
func pair(a, b int64) (int64, int64) {
	if a < b {
		return a, b
	}
	return b, a
}

// RequestFriend asks `to` to be friends with `from`. When `to` had already
// asked `from`, the two are friends at once.
func (s *Store) RequestFriend(ctx context.Context, from, to int64) (FriendState, error) {
	state, _, err := s.AskFriend(ctx, from, to)
	return state, err
}

// AskFriend is RequestFriend that also says whether the ask is new, rather
// than one already waiting on `to`.
func (s *Store) AskFriend(ctx context.Context, from, to int64) (state FriendState, fresh bool, err error) {
	if from == to {
		return "", false, ErrInvalid
	}
	if _, err := s.Get(ctx, to); err != nil {
		return "", false, err
	}
	if already, err := s.AreFriends(ctx, from, to); err != nil {
		return "", false, err
	} else if already {
		return FriendAccepted, false, nil
	}
	var asked bool
	if err := s.pool.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM friend_requests WHERE from_id = $1 AND to_id = $2)", to, from).Scan(&asked); err != nil {
		return "", false, err
	}
	if asked {
		return FriendAccepted, false, s.AcceptFriend(ctx, from, to)
	}
	tag, err := s.pool.Exec(ctx, "INSERT INTO friend_requests (from_id, to_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", from, to)
	if err != nil {
		return "", false, err
	}
	return FriendRequested, tag.RowsAffected() == 1, nil
}

// AcceptFriend is `id` saying yes to the request `from` sent.
func (s *Store) AcceptFriend(ctx context.Context, id, from int64) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, "DELETE FROM friend_requests WHERE from_id = $1 AND to_id = $2", from, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNoRequest
	}
	if _, err := tx.Exec(ctx, "DELETE FROM friend_requests WHERE from_id = $1 AND to_id = $2", id, from); err != nil {
		return err
	}
	a, b := pair(id, from)
	if _, err := tx.Exec(ctx, "INSERT INTO friendships (a, b) VALUES ($1, $2) ON CONFLICT DO NOTHING", a, b); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// DeclineFriend is `id` saying no to the request `from` sent; a friendship
// already made stays.
func (s *Store) DeclineFriend(ctx context.Context, id, from int64) error {
	tag, err := s.pool.Exec(ctx, "DELETE FROM friend_requests WHERE from_id = $1 AND to_id = $2", from, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNoRequest
	}
	return nil
}

// RemoveFriend ends a friendship, and also withdraws or declines a pending
// request between the two.
func (s *Store) RemoveFriend(ctx context.Context, id, other int64) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	a, b := pair(id, other)
	if _, err := tx.Exec(ctx, "DELETE FROM friendships WHERE a = $1 AND b = $2", a, b); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM friend_requests
		WHERE (from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1)`, id, other); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) Friends(ctx context.Context, id int64) ([]int64, error) {
	return s.ids(ctx, `SELECT CASE WHEN a = $1 THEN b ELSE a END AS other
		FROM friendships WHERE a = $1 OR b = $1 ORDER BY other`, id)
}

func (s *Store) AreFriends(ctx context.Context, a, b int64) (bool, error) {
	a, b = pair(a, b)
	var friends bool
	err := s.pool.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM friendships WHERE a = $1 AND b = $2)", a, b).Scan(&friends)
	return friends, err
}

func (s *Store) FriendCount(ctx context.Context, id int64) (int64, error) {
	var count int64
	err := s.pool.QueryRow(ctx, "SELECT count(*) FROM friendships WHERE a = $1 OR b = $1", id).Scan(&count)
	return count, err
}

// FriendRequests are the asks waiting on `id` and the ones `id` sent.
func (s *Store) FriendRequests(ctx context.Context, id int64) (incoming, outgoing []int64, err error) {
	if incoming, err = s.ids(ctx, "SELECT from_id FROM friend_requests WHERE to_id = $1 ORDER BY from_id", id); err != nil {
		return nil, nil, err
	}
	outgoing, err = s.ids(ctx, "SELECT to_id FROM friend_requests WHERE from_id = $1 ORDER BY to_id", id)
	return incoming, outgoing, err
}

func (s *Store) ids(ctx context.Context, query string, args ...any) ([]int64, error) {
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return nil, err
	}
	if ids == nil {
		ids = []int64{}
	}
	return ids, nil
}

// RecordWatch keeps a watch at the top of the account's history and counts
// it; past historyKept, the oldest go.
func (s *Store) RecordWatch(ctx context.Context, id int64, watch Watch) error {
	with := watch.With
	if with == nil {
		with = []int64{}
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `INSERT INTO watches (account_id, room_id, title, kind, started_at, duration_sec, with_ids)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		id, watch.RoomID, watch.Title, watch.Kind, watch.StartedAt, watch.DurationSec, with); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE accounts SET sessions = sessions + 1, watched_seconds = watched_seconds + $2
		WHERE id = $1`, id, watch.DurationSec); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM watches WHERE account_id = $1 AND id NOT IN (
		SELECT id FROM watches WHERE account_id = $1 ORDER BY started_at DESC, id DESC LIMIT $2)`,
		id, historyKept); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) History(ctx context.Context, id int64, limit int) ([]Watch, error) {
	rows, err := s.pool.Query(ctx, `SELECT room_id, title, kind, started_at, duration_sec, with_ids
		FROM watches WHERE account_id = $1 ORDER BY started_at DESC, id DESC LIMIT $2`, id, limit)
	if err != nil {
		return nil, err
	}
	history, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Watch, error) {
		var watch Watch
		err := row.Scan(&watch.RoomID, &watch.Title, &watch.Kind, &watch.StartedAt, &watch.DurationSec, &watch.With)
		watch.StartedAt = watch.StartedAt.UTC()
		if len(watch.With) == 0 {
			watch.With = nil
		}
		return watch, err
	})
	if err != nil {
		return nil, err
	}
	if history == nil {
		history = []Watch{}
	}
	return history, nil
}

// ValidAvatar is whether a short avatar spec like `fox.bowtie` is fit to
// keep or show; the browser draws it, the server only checks its shape.
func ValidAvatar(value string) bool {
	return len(value) <= maxAvatarBytes && avatarRe.MatchString(value)
}

func validNickname(value string) bool {
	if value == "" || utf8.RuneCountInString(value) > maxNicknameRunes || !utf8.ValidString(value) {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// cleanDiscordName keeps a Discord name printable and short.
func cleanDiscordName(value string) string {
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, strings.TrimSpace(value))
	if runes := []rune(value); len(runes) > maxNicknameRunes {
		value = string(runes[:maxNicknameRunes])
	}
	return value
}

// cleanNickname fits a Discord name into a nickname, or gives "".
func cleanNickname(value string) string {
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, strings.TrimSpace(value))
	if runes := []rune(value); len(runes) > maxNicknameRunes {
		value = strings.TrimSpace(string(runes[:maxNicknameRunes]))
	}
	if !validNickname(value) {
		return ""
	}
	return value
}

// RoomInvite is a friend calling the account into a room; one per friend,
// the newest standing.
type RoomInvite struct {
	From   int64     `json:"from"`
	RoomID string    `json:"roomId"`
	At     time.Time `json:"at"`
}

func (s *Store) AddInvite(ctx context.Context, to int64, invite RoomInvite) error {
	if _, err := s.pool.Exec(ctx, "DELETE FROM room_invites WHERE expires_at < $1", invite.At); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `INSERT INTO room_invites (to_id, from_id, room_id, at, expires_at)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (to_id, from_id) DO UPDATE
		SET room_id = excluded.room_id, at = excluded.at, expires_at = excluded.expires_at`,
		to, invite.From, invite.RoomID, invite.At, invite.At.Add(InviteTTL))
	return err
}

// Invites are the calls still waiting on `to`, newest first; the stale ones
// are dropped on the way.
func (s *Store) Invites(ctx context.Context, to int64, now time.Time) ([]RoomInvite, error) {
	if _, err := s.pool.Exec(ctx, "DELETE FROM room_invites WHERE to_id = $1 AND expires_at < $2", to, now); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, "SELECT from_id, room_id, at FROM room_invites WHERE to_id = $1 ORDER BY at DESC", to)
	if err != nil {
		return nil, err
	}
	invites, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (RoomInvite, error) {
		var invite RoomInvite
		err := row.Scan(&invite.From, &invite.RoomID, &invite.At)
		invite.At = invite.At.UTC()
		return invite, err
	})
	if err != nil {
		return nil, err
	}
	if invites == nil {
		invites = []RoomInvite{}
	}
	return invites, nil
}

func (s *Store) DropInvite(ctx context.Context, to, from int64) error {
	_, err := s.pool.Exec(ctx, "DELETE FROM room_invites WHERE to_id = $1 AND from_id = $2", to, from)
	return err
}

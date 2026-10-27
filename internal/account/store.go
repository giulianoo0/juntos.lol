// Package account keeps the people who signed in with Discord: their number,
// how they show up, their friends and what they watched.
package account

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/redis/go-redis/v9"
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
	InviteTTL = time.Hour
	sessionLen  = 32
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
	rdb *redis.Client
}

func NewStore(rdb *redis.Client) *Store { return &Store{rdb: rdb} }

func accountKey(id int64) string         { return "account:" + strconv.FormatInt(id, 10) }
func discordKey(discordID string) string { return "account:discord:" + discordID }
func friendsKey(id int64) string         { return accountKey(id) + ":friends" }
func incomingKey(id int64) string        { return accountKey(id) + ":requests:in" }
func outgoingKey(id int64) string        { return accountKey(id) + ":requests:out" }
func historyKey(id int64) string         { return accountKey(id) + ":history" }
func sessionKey(token string) string     { return "account:session:" + token }
func invitesKey(id int64) string         { return accountKey(id) + ":invites" }

const seqKey = "account:seq"

// SignInDiscord finds the account behind a Discord user, or opens the next
// numbered one named after them. Coming back never spends a number, and
// refreshes the Discord names kept with the account.
func (s *Store) SignInDiscord(ctx context.Context, user DiscordUser) (Account, error) {
	if user.ID == "" {
		return Account{}, ErrInvalid
	}
	names := []any{"discordUsername", cleanDiscordName(user.Username), "discordGlobalName", cleanDiscordName(user.GlobalName)}
	if id, err := s.rdb.Get(ctx, discordKey(user.ID)).Int64(); err == nil {
		if err := s.rdb.HSet(ctx, accountKey(id), names...).Err(); err != nil {
			return Account{}, err
		}
		return s.Get(ctx, id)
	} else if !errors.Is(err, redis.Nil) {
		return Account{}, err
	}
	id, err := s.rdb.Incr(ctx, seqKey).Result()
	if err != nil {
		return Account{}, err
	}
	nickname := cleanNickname(user.displayName())
	if nickname == "" {
		nickname = "#" + strconv.FormatInt(id, 10)
	}
	created := Account{ID: id, DiscordID: user.ID, Nickname: nickname, Visibility: VisibilityPrivate,
		DiscordUsername: cleanDiscordName(user.Username), DiscordGlobalName: cleanDiscordName(user.GlobalName),
		DiscordVisibility: VisibilityPrivate, CreatedAt: time.Now().UTC().Truncate(time.Second)}
	fields := append([]any{
		"discordId", user.ID, "nickname", nickname, "avatar", "",
		"visibility", created.Visibility, "discordVisibility", created.DiscordVisibility,
		"createdAt", created.CreatedAt.Format(time.RFC3339), "sessions", 0, "watchedSeconds", 0,
	}, names...)
	if err := s.rdb.HSet(ctx, accountKey(id), fields...).Err(); err != nil {
		return Account{}, err
	}
	won, err := s.rdb.SetNX(ctx, discordKey(user.ID), id, 0).Result()
	if err != nil {
		return Account{}, err
	}
	if !won {
		// Another sign-in of the same person got there first: theirs stands.
		s.rdb.Del(ctx, accountKey(id))
		existing, err := s.rdb.Get(ctx, discordKey(user.ID)).Int64()
		if err != nil {
			return Account{}, err
		}
		return s.Get(ctx, existing)
	}
	return created, nil
}

// ByDiscord is the account a Discord user signed in as, or ErrNotFound.
func (s *Store) ByDiscord(ctx context.Context, discordID string) (Account, error) {
	id, err := s.rdb.Get(ctx, discordKey(discordID)).Int64()
	if errors.Is(err, redis.Nil) {
		return Account{}, ErrNotFound
	}
	if err != nil {
		return Account{}, err
	}
	return s.Get(ctx, id)
}

func (s *Store) Get(ctx context.Context, id int64) (Account, error) {
	fields, err := s.rdb.HGetAll(ctx, accountKey(id)).Result()
	if err != nil {
		return Account{}, err
	}
	if len(fields) == 0 {
		return Account{}, ErrNotFound
	}
	created, _ := time.Parse(time.RFC3339, fields["createdAt"])
	sessions, _ := strconv.ParseInt(fields["sessions"], 10, 64)
	watched, _ := strconv.ParseInt(fields["watchedSeconds"], 10, 64)
	discordShown := fields["discordVisibility"]
	if discordShown != VisibilityPublic {
		discordShown = VisibilityPrivate
	}
	return Account{
		ID: id, DiscordID: fields["discordId"], Nickname: fields["nickname"], Avatar: fields["avatar"],
		DiscordUsername: fields["discordUsername"], DiscordGlobalName: fields["discordGlobalName"],
		DiscordVisibility: discordShown, Visibility: fields["visibility"], CreatedAt: created,
		Sessions: sessions, WatchedSeconds: watched,
	}, nil
}

func (s *Store) Update(ctx context.Context, id int64, changes Changes) (Account, error) {
	fields := []any{}
	if changes.Nickname != nil {
		nickname := strings.TrimSpace(*changes.Nickname)
		if !validNickname(nickname) {
			return Account{}, ErrInvalid
		}
		fields = append(fields, "nickname", nickname)
	}
	if changes.Avatar != nil {
		if *changes.Avatar != "" && !ValidAvatar(*changes.Avatar) {
			return Account{}, ErrInvalid
		}
		fields = append(fields, "avatar", *changes.Avatar)
	}
	if changes.Visibility != nil {
		switch *changes.Visibility {
		case VisibilityPublic, VisibilityFriends, VisibilityPrivate:
		default:
			return Account{}, ErrInvalid
		}
		fields = append(fields, "visibility", *changes.Visibility)
	}
	if changes.DiscordVisibility != nil {
		switch *changes.DiscordVisibility {
		case VisibilityPublic, VisibilityPrivate:
		default:
			return Account{}, ErrInvalid
		}
		fields = append(fields, "discordVisibility", *changes.DiscordVisibility)
	}
	if exists, err := s.rdb.Exists(ctx, accountKey(id)).Result(); err != nil {
		return Account{}, err
	} else if exists == 0 {
		return Account{}, ErrNotFound
	}
	if len(fields) > 0 {
		if err := s.rdb.HSet(ctx, accountKey(id), fields...).Err(); err != nil {
			return Account{}, err
		}
	}
	return s.Get(ctx, id)
}

// StartSession opens a sign-in for the cookie; the token is the only key to it.
func (s *Store) StartSession(ctx context.Context, id int64) (string, error) {
	raw := make([]byte, sessionLen)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	token := hex.EncodeToString(raw)
	if err := s.rdb.Set(ctx, sessionKey(token), id, sessionTTL).Err(); err != nil {
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
	id, err := s.rdb.GetEx(ctx, sessionKey(token), sessionTTL).Int64()
	if errors.Is(err, redis.Nil) {
		return 0, nil
	}
	return id, err
}

func (s *Store) EndSession(ctx context.Context, token string) error {
	return s.rdb.Del(ctx, sessionKey(token)).Err()
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
	if already, err := s.rdb.SIsMember(ctx, friendsKey(from), to).Result(); err != nil {
		return "", false, err
	} else if already {
		return FriendAccepted, false, nil
	}
	if asked, err := s.rdb.SIsMember(ctx, incomingKey(from), to).Result(); err != nil {
		return "", false, err
	} else if asked {
		return FriendAccepted, false, s.AcceptFriend(ctx, from, to)
	}
	pipe := s.rdb.TxPipeline()
	pipe.SAdd(ctx, outgoingKey(from), to)
	added := pipe.SAdd(ctx, incomingKey(to), from)
	if _, err := pipe.Exec(ctx); err != nil {
		return "", false, err
	}
	return FriendRequested, added.Val() == 1, nil
}

// AcceptFriend is `id` saying yes to the request `from` sent.
func (s *Store) AcceptFriend(ctx context.Context, id, from int64) error {
	removed, err := s.rdb.SRem(ctx, incomingKey(id), from).Result()
	if err != nil {
		return err
	}
	if removed == 0 {
		return ErrNoRequest
	}
	pipe := s.rdb.TxPipeline()
	pipe.SRem(ctx, outgoingKey(from), id)
	pipe.SRem(ctx, outgoingKey(id), from)
	pipe.SRem(ctx, incomingKey(from), id)
	pipe.SAdd(ctx, friendsKey(id), from)
	pipe.SAdd(ctx, friendsKey(from), id)
	_, err = pipe.Exec(ctx)
	return err
}

// DeclineFriend is `id` saying no to the request `from` sent; a friendship
// already made stays.
func (s *Store) DeclineFriend(ctx context.Context, id, from int64) error {
	removed, err := s.rdb.SRem(ctx, incomingKey(id), from).Result()
	if err != nil {
		return err
	}
	if removed == 0 {
		return ErrNoRequest
	}
	return s.rdb.SRem(ctx, outgoingKey(from), id).Err()
}

// RemoveFriend ends a friendship, and also withdraws or declines a pending
// request between the two.
func (s *Store) RemoveFriend(ctx context.Context, id, other int64) error {
	pipe := s.rdb.TxPipeline()
	pipe.SRem(ctx, friendsKey(id), other)
	pipe.SRem(ctx, friendsKey(other), id)
	pipe.SRem(ctx, incomingKey(id), other)
	pipe.SRem(ctx, outgoingKey(id), other)
	pipe.SRem(ctx, incomingKey(other), id)
	pipe.SRem(ctx, outgoingKey(other), id)
	_, err := pipe.Exec(ctx)
	return err
}

func (s *Store) Friends(ctx context.Context, id int64) ([]int64, error) {
	return s.ids(ctx, friendsKey(id))
}

func (s *Store) AreFriends(ctx context.Context, a, b int64) (bool, error) {
	return s.rdb.SIsMember(ctx, friendsKey(a), b).Result()
}

func (s *Store) FriendCount(ctx context.Context, id int64) (int64, error) {
	return s.rdb.SCard(ctx, friendsKey(id)).Result()
}

// FriendRequests are the asks waiting on `id` and the ones `id` sent.
func (s *Store) FriendRequests(ctx context.Context, id int64) (incoming, outgoing []int64, err error) {
	if incoming, err = s.ids(ctx, incomingKey(id)); err != nil {
		return nil, nil, err
	}
	outgoing, err = s.ids(ctx, outgoingKey(id))
	return incoming, outgoing, err
}

func (s *Store) ids(ctx context.Context, key string) ([]int64, error) {
	members, err := s.rdb.SMembers(ctx, key).Result()
	if err != nil {
		return nil, err
	}
	ids := make([]int64, 0, len(members))
	for _, member := range members {
		if id, err := strconv.ParseInt(member, 10, 64); err == nil {
			ids = append(ids, id)
		}
	}
	slices.Sort(ids)
	return ids, nil
}

// RecordWatch keeps a watch at the top of the account's history and counts it.
func (s *Store) RecordWatch(ctx context.Context, id int64, watch Watch) error {
	raw, err := json.Marshal(watch)
	if err != nil {
		return fmt.Errorf("marshal watch: %w", err)
	}
	pipe := s.rdb.TxPipeline()
	pipe.LPush(ctx, historyKey(id), raw)
	pipe.LTrim(ctx, historyKey(id), 0, historyKept-1)
	pipe.HIncrBy(ctx, accountKey(id), "sessions", 1)
	pipe.HIncrBy(ctx, accountKey(id), "watchedSeconds", watch.DurationSec)
	_, err = pipe.Exec(ctx)
	return err
}

func (s *Store) History(ctx context.Context, id int64, limit int) ([]Watch, error) {
	raws, err := s.rdb.LRange(ctx, historyKey(id), 0, int64(limit)-1).Result()
	if err != nil {
		return nil, err
	}
	history := make([]Watch, 0, len(raws))
	for _, raw := range raws {
		var watch Watch
		if json.Unmarshal([]byte(raw), &watch) == nil {
			history = append(history, watch)
		}
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
	raw, err := json.Marshal(invite)
	if err != nil {
		return err
	}
	pipe := s.rdb.TxPipeline()
	pipe.HSet(ctx, invitesKey(to), strconv.FormatInt(invite.From, 10), raw)
	pipe.Expire(ctx, invitesKey(to), InviteTTL)
	_, err = pipe.Exec(ctx)
	return err
}

// Invites are the calls still waiting on `to`, newest first; the stale ones
// are dropped on the way.
func (s *Store) Invites(ctx context.Context, to int64, now time.Time) ([]RoomInvite, error) {
	raws, err := s.rdb.HGetAll(ctx, invitesKey(to)).Result()
	if err != nil {
		return nil, err
	}
	invites := make([]RoomInvite, 0, len(raws))
	for field, raw := range raws {
		var invite RoomInvite
		if json.Unmarshal([]byte(raw), &invite) != nil || now.Sub(invite.At) > InviteTTL {
			s.rdb.HDel(ctx, invitesKey(to), field)
			continue
		}
		invites = append(invites, invite)
	}
	slices.SortFunc(invites, func(a, b RoomInvite) int { return b.At.Compare(a.At) })
	return invites, nil
}

func (s *Store) DropInvite(ctx context.Context, to, from int64) error {
	return s.rdb.HDel(ctx, invitesKey(to), strconv.FormatInt(from, 10)).Err()
}

package sync

import (
	"context"
	"log/slog"
	"net/http"
	"slices"
	"time"

	"github.com/giulianoo0/ss/internal/account"
	"github.com/giulianoo0/ss/internal/room"
)

// Identity is the account a socket signed in as, as the room shows it.
type Identity struct {
	AccountID int64
	Avatar    string
	// Unlisted: a private account, whose number the room never shows.
	Unlisted bool
}

// Accounts tells the hub who is behind a socket and keeps what signed-in
// members watched.
type Accounts interface {
	// Identify reads the sign-in off the upgrade request; false is a guest.
	Identify(r *http.Request) (Identity, bool)
	RecordWatch(ctx context.Context, accountID int64, watch account.Watch) error
}

// minWatch is the shortest stretch worth a line in the history: a peek is
// not a session. A variable so tests can record every stretch.
var minWatch = time.Minute

// watchSpan is a signed-in member in front of one media, since start.
type watchSpan struct {
	start time.Time
	title string
	kind  string
	with  map[int64]struct{}
}

// SetAccounts wires sign-in into the rooms. Set once at startup.
func (h *Hub) SetAccounts(accounts Accounts) {
	h.mu.Lock()
	h.accounts = accounts
	h.mu.Unlock()
}

func (h *Hub) accountsOf() Accounts {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.accounts
}

func (h *Hub) identify(r *http.Request) Identity {
	accounts := h.accountsOf()
	if accounts == nil {
		return Identity{}
	}
	identity, ok := accounts.Identify(r)
	if !ok {
		return Identity{}
	}
	return identity
}

// Presence is the room each of the given accounts is in right now; an
// account in none is left out. A seat held for a dropped socket counts.
func (h *Hub) Presence(accountIDs []int64) map[int64]string {
	h.mu.Lock()
	defer h.mu.Unlock()
	present := make(map[int64]string)
	for _, id := range accountIDs {
		for roomID := range h.presence[id] {
			present[id] = roomID
			break
		}
	}
	return present
}

func (h *Hub) markPresent(accountID int64, roomID string, here bool) {
	if accountID == 0 {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	rooms := h.presence[accountID]
	if here {
		if rooms == nil {
			rooms = make(map[string]int)
			h.presence[accountID] = rooms
		}
		rooms[roomID]++
		return
	}
	if rooms[roomID]--; rooms[roomID] <= 0 {
		delete(rooms, roomID)
	}
	if len(rooms) == 0 {
		delete(h.presence, accountID)
	}
}

// seats is every member in the room, connected or held.
func (r *roomConn) seats() []*client {
	seats := make([]*client, 0, len(r.clients)+len(r.detached))
	for _, connected := range r.clients {
		seats = append(seats, connected)
	}
	for _, seat := range r.detached {
		seats = append(seats, seat.client)
	}
	return seats
}

// nowShowing is what the room's media stage plays, or its live when the
// stage is empty.
func (r *roomConn) nowShowing(ctx context.Context) (title, kind string) {
	stored, err := r.hub.store.Get(ctx, r.id)
	if err != nil {
		return "", ""
	}
	if stored.HasMedia() && stored.FileName != "" {
		kind = stored.SourceOrigin
		if kind == "" {
			kind = "media"
		}
		return stored.FileName, kind
	}
	if stored.Live != nil && stored.Live.Title != "" {
		return stored.Live.Title, "live"
	}
	return "", ""
}

// arrived starts a signed-in member's watch and marks them present; the
// members already watching now watch with them.
func (r *roomConn) arrived(ctx context.Context, member *client) {
	accountID := member.member.AccountID
	if accountID == 0 {
		return
	}
	r.hub.markPresent(accountID, r.id, true)
	title, kind := r.nowShowing(ctx)
	r.openWatch(member, title, kind, time.Now())
	for _, other := range r.seats() {
		if other != member && other.watch != nil {
			other.watch.with[accountID] = struct{}{}
		}
	}
}

func (r *roomConn) openWatch(member *client, title, kind string, now time.Time) {
	with := make(map[int64]struct{})
	for _, other := range r.seats() {
		if other != member && other.member.AccountID != 0 && other.member.AccountID != member.member.AccountID {
			with[other.member.AccountID] = struct{}{}
		}
	}
	member.watch = &watchSpan{start: now, title: title, kind: kind, with: with}
}

// left ends a signed-in member's watch for good. A watch that began on an
// empty stage takes whatever the room shows when they go.
func (r *roomConn) left(ctx context.Context, member *client) {
	accountID := member.member.AccountID
	if accountID == 0 {
		return
	}
	r.hub.markPresent(accountID, r.id, false)
	if member.watch != nil && member.watch.title == "" {
		member.watch.title, member.watch.kind = r.nowShowing(ctx)
	}
	r.closeWatch(ctx, member, time.Now())
}

// mediaChanged closes every watch on the media that went and opens one on
// what came in its place.
func (r *roomConn) mediaChanged(ctx context.Context) {
	title, kind := r.nowShowing(ctx)
	now := time.Now()
	for _, member := range r.seats() {
		if member.member.AccountID == 0 {
			continue
		}
		r.closeWatch(ctx, member, now)
		r.openWatch(member, title, kind, now)
	}
}

func (r *roomConn) closeWatch(ctx context.Context, member *client, now time.Time) {
	span := member.watch
	member.watch = nil
	accounts := r.hub.accountsOf()
	if span == nil || accounts == nil || span.title == "" || now.Sub(span.start) < minWatch {
		return
	}
	with := make([]int64, 0, len(span.with))
	for id := range span.with {
		with = append(with, id)
	}
	slices.Sort(with)
	watch := account.Watch{
		RoomID: r.id, Title: span.title, Kind: span.kind, StartedAt: span.start.UTC(),
		DurationSec: int64(now.Sub(span.start) / time.Second), With: with,
	}
	if err := accounts.RecordWatch(ctx, member.member.AccountID, watch); err != nil {
		slog.ErrorContext(ctx, "record watch failed", "room_id", r.id, "account_id", member.member.AccountID, "error", err)
	}
}

// pickedAvatar fills the seat's avatar with the one the hello brought when
// the account has none of its own and the pick is fit to show.
func pickedAvatar(identity Identity, picked string) Identity {
	if identity.Avatar == "" && account.ValidAvatar(picked) {
		identity.Avatar = picked
	}
	return identity
}

// withIdentity stamps the account on a member about to take a seat.
func withIdentity(member room.Member, identity Identity) room.Member {
	member.AccountID = identity.AccountID
	member.Avatar = identity.Avatar
	member.Unlisted = identity.Unlisted
	return member
}

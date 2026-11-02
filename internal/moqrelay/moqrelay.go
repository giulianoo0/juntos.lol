// Package moqrelay gives every room a MoQ relay of its own on Cloudflare.
//
// Cloudflare scopes a relay's tokens to operations, never to paths, and a
// subscriber can list every broadcast on the relay it holds a token for. One
// relay for all rooms meant anyone who ever got into any room could find and
// watch every other. A relay per room limits a token to the room it came
// from, and moving the room to a new relay when someone is kicked leaves the
// kicked holding a token to a relay nobody publishes on anymore.
package moqrelay

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
)

// NamePrefix marks the relays one deployment owns. Every server on the
// account sweeps only its own: to another, every room is a room it lacks.
func NamePrefix(owner string) string {
	return "juntos-" + owner + "-room-"
}

// sweepGrace keeps the sweeper off a relay created moments ago, whose room
// may not have recorded it yet.
const sweepGrace = 5 * time.Minute

// Relay is where a room's broadcasts go, with the two tokens it hands out.
type Relay struct {
	URL       string
	Publish   string
	Subscribe string
	Epoch     int
}

// PublishURL is the relay with the token that may publish.
func (r Relay) PublishURL() string { return r.URL + "/" + r.Publish }

// SubscribeURL is the relay with the token that may only watch.
func (r Relay) SubscribeURL() string { return r.URL + "/" + r.Subscribe }

// ErrUnavailable is a room that could not get a relay; nothing is shared
// through another room's relay instead.
var ErrUnavailable = errors.New("room relay unavailable")

type roomRelays interface {
	RoomRelay(ctx context.Context, id string) (room.Relay, error)
	SwapRoomRelay(ctx context.Context, id, from string, to room.Relay) (int, error)
}

// Rooms hands out each room's relay, making it the first time it is asked for.
type Rooms struct {
	url    string
	prefix string
	// moving holds one lock per room being moved, so two kicks in a row
	// move it twice in turn instead of racing each other.
	moving sync.Map
	shared *Relay
	api    *API
	store  roomRelays
	group  singleflight.Group
}

// PerRoom gives every room its own relay through the Cloudflare API, named
// after the owner (the deployment's host).
func PerRoom(relayURL, owner string, api *API, store roomRelays) *Rooms {
	return &Rooms{url: relayURL, prefix: NamePrefix(owner), api: api, store: store}
}

// Shared puts every room on one relay with fixed tokens. Fit only for a
// setup nobody else uses, such as local tests: its tokens open every room.
func Shared(relayURL, publish, subscribe string) *Rooms {
	return &Rooms{url: relayURL, shared: &Relay{URL: relayURL, Publish: publish, Subscribe: subscribe}}
}

// ForRoom returns the room's relay.
func (r *Rooms) ForRoom(ctx context.Context, roomID string) (Relay, error) {
	if r.shared != nil {
		return *r.shared, nil
	}
	current, err := r.store.RoomRelay(ctx, roomID)
	if err != nil {
		return Relay{}, err
	}
	if current.UID != "" {
		return r.relay(current), nil
	}
	// Every member of a fresh room asks at once; one relay is made for all.
	made, err, _ := r.group.Do(roomID, func() (any, error) {
		return r.move(context.WithoutCancel(ctx), roomID, "")
	})
	if err != nil {
		return Relay{}, err
	}
	return made.(Relay), nil
}

// Rotate moves a room that has a relay to a new one, so tokens handed out
// before stop reaching what the room publishes from now on. It reports
// whether the room moved; a room still without a relay has nothing to leave.
func (r *Rooms) Rotate(ctx context.Context, roomID string) (bool, error) {
	if r.shared != nil {
		return false, nil
	}
	lock, _ := r.moving.LoadOrStore(roomID, &sync.Mutex{})
	lock.(*sync.Mutex).Lock()
	defer lock.(*sync.Mutex).Unlock()
	current, err := r.store.RoomRelay(ctx, roomID)
	if err != nil || current.UID == "" {
		return false, err
	}
	if _, err := r.move(ctx, roomID, current.UID); err != nil {
		return false, err
	}
	r.drop(ctx, roomID, current.UID)
	return true, nil
}

// The wait between tries to move a room after a kick, doubling up to a minute.
var moveRetryFirst = 2 * time.Second

const moveRetryMax = time.Minute

// MoveAfterKick moves the room to a new relay, trying again for as long as
// Cloudflare refuses: a room left on the old relay is a room the kicked can
// still watch. moved runs once it has, and not at all for a room that ended
// or never had a relay.
func (r *Rooms) MoveAfterKick(ctx context.Context, roomID string, moved func()) {
	wait := moveRetryFirst
	for {
		done, err := r.Rotate(ctx, roomID)
		if err == nil || errors.Is(err, room.ErrNotFound) {
			if done {
				moved()
			}
			return
		}
		slog.ErrorContext(ctx, "move room relay after a kick", "room_id", roomID, "error", err, "retry_in", wait)
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		wait = min(wait*2, moveRetryMax)
	}
}

func (r *Rooms) move(ctx context.Context, roomID, from string) (Relay, error) {
	made, err := r.api.Create(ctx, r.prefix+roomID)
	if err != nil {
		slog.ErrorContext(ctx, "create room relay", "room_id", roomID, "error", err)
		return Relay{}, ErrUnavailable
	}
	epoch, err := r.store.SwapRoomRelay(ctx, roomID, from, made)
	if err != nil {
		r.drop(ctx, roomID, made.UID)
		if errors.Is(err, room.ErrRelayMoved) {
			current, err := r.store.RoomRelay(ctx, roomID)
			if err != nil {
				return Relay{}, err
			}
			return r.relay(current), nil
		}
		return Relay{}, err
	}
	made.Epoch = epoch
	slog.InfoContext(ctx, "room relay", "room_id", roomID, "relay", made.UID, "epoch", epoch)
	return r.relay(made), nil
}

func (r *Rooms) drop(ctx context.Context, roomID, uid string) {
	if err := r.api.Delete(context.WithoutCancel(ctx), uid); err != nil {
		slog.WarnContext(ctx, "delete room relay", "room_id", roomID, "relay", uid, "error", err)
	}
}

func (r *Rooms) relay(stored room.Relay) Relay {
	return Relay{URL: r.url, Publish: stored.Publish, Subscribe: stored.Subscribe, Epoch: stored.Epoch}
}

// Sweep deletes the relays of rooms that are gone and the ones rooms moved
// away from, which a crash or a failed delete can leave behind.
func (r *Rooms) Sweep(ctx context.Context) error {
	if r.shared != nil {
		return nil
	}
	relays, err := r.api.List(ctx)
	if err != nil {
		return err
	}
	for _, listed := range relays {
		roomID, ours := strings.CutPrefix(listed.Name, r.prefix)
		if !ours || time.Since(listed.Created) < sweepGrace {
			continue
		}
		current, err := r.store.RoomRelay(ctx, roomID)
		if err != nil && !errors.Is(err, room.ErrNotFound) {
			return fmt.Errorf("sweep room relays: %w", err)
		}
		if err == nil && current.UID == listed.UID {
			continue
		}
		r.drop(ctx, roomID, listed.UID)
	}
	return nil
}

// RunSweeper sweeps until ctx ends.
func (r *Rooms) RunSweeper(ctx context.Context, every time.Duration) {
	if r.shared != nil {
		return
	}
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		if err := r.Sweep(ctx); err != nil {
			slog.WarnContext(ctx, "sweep room relays", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// FromConfig is a relay per room when the API is configured, and the shared
// relay otherwise.
func FromConfig(cfg config.Config, store roomRelays) *Rooms {
	if cfg.MoqRelaysPerRoom() {
		return PerRoom(cfg.MoqRelayURL, cfg.MoqRelayOwner, NewAPI(cfg.MoqAccountID, cfg.MoqAPIToken), store)
	}
	return Shared(cfg.MoqRelayURL, cfg.MoqPublishToken, cfg.MoqSubscribeToken)
}

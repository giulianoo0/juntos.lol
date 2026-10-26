package discord

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	stdsync "sync"
	"time"
)

// Card is what the room card shows besides its name: who is in, and what is playing.
type Card struct {
	Members []string
	Playing string
}

// CardSource reads a room's current card.
type CardSource interface {
	Card(ctx context.Context, roomID string) (Card, error)
}

// cardNames is how many names the card lists before it only counts the rest.
const cardNames = 8

const callTimeout = 10 * time.Second

// Notifier keeps a room's card in its Discord channel up to date. It is the
// hub's ActivityNotifier: the card goes up when the host first takes their
// seat, follows arrivals, departures and media a debounce later, and says the
// room is over when it closes. Rooms not made from Discord are ignored.
type Notifier struct {
	API    *API
	Links  *LinkStore
	Cards  CardSource
	Origin string
	// Debounce gathers a burst of changes into one edit.
	Debounce time.Duration
	Now      func() time.Time

	mu      stdsync.Mutex
	pending map[string]*time.Timer
	locks   map[string]*stdsync.Mutex
}

func (n *Notifier) HostJoined(roomID string) {
	n.run(roomID, func(ctx context.Context) {
		link, err := n.Links.Get(ctx, roomID)
		if err != nil || link.MessageID != "" {
			return
		}
		message, err := n.message(ctx, roomID, link)
		if err != nil {
			slog.ErrorContext(ctx, "discord card read failed", "room_id", roomID, "error", err)
			return
		}
		switch {
		case link.GuildInstalled && n.API.BotToken != "":
			link.MessageID, err = n.API.CreateChannelMessage(ctx, link.ChannelID, message)
			link.ViaBot = true
		case n.now().Before(link.TokenExpiresAt):
			link.MessageID, err = n.API.CreateFollowup(ctx, link.InteractionToken, message)
		default:
			return
		}
		if err != nil {
			slog.ErrorContext(ctx, "discord card post failed", "room_id", roomID, "error", err)
			return
		}
		if err := n.Links.Put(ctx, roomID, *link); err != nil {
			slog.ErrorContext(ctx, "discord card link save failed", "room_id", roomID, "error", err)
		}
	})
}

func (n *Notifier) RoomChanged(roomID string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.pending == nil {
		n.pending = make(map[string]*time.Timer)
	}
	if _, waiting := n.pending[roomID]; waiting {
		return
	}
	n.pending[roomID] = time.AfterFunc(n.Debounce, func() {
		n.mu.Lock()
		delete(n.pending, roomID)
		n.mu.Unlock()
		n.run(roomID, func(ctx context.Context) {
			link, err := n.Links.Get(ctx, roomID)
			if err != nil || link.MessageID == "" {
				return
			}
			message, err := n.message(ctx, roomID, link)
			if err != nil {
				slog.ErrorContext(ctx, "discord card read failed", "room_id", roomID, "error", err)
				return
			}
			n.edit(ctx, roomID, link, message)
		})
	})
}

func (n *Notifier) RoomClosed(roomID string) {
	n.mu.Lock()
	if timer, waiting := n.pending[roomID]; waiting {
		timer.Stop()
		delete(n.pending, roomID)
	}
	n.mu.Unlock()
	n.run(roomID, func(ctx context.Context) {
		link, err := n.Links.Get(ctx, roomID)
		if errors.Is(err, ErrNoLink) {
			return
		}
		if err == nil && link.MessageID != "" {
			n.edit(ctx, roomID, link, map[string]any{
				"embeds":     []any{map[string]any{"title": cardTitle(link), "description": "Sala encerrada"}},
				"components": []any{},
			})
		}
		if err := n.Links.Delete(ctx, roomID); err != nil {
			slog.ErrorContext(ctx, "discord card link delete failed", "room_id", roomID, "error", err)
		}
		n.mu.Lock()
		delete(n.locks, roomID)
		n.mu.Unlock()
	})
}

// edit writes the card through whichever API posted it. A card posted with
// the interaction's token freezes once that token lapses.
func (n *Notifier) edit(ctx context.Context, roomID string, link *Link, message any) {
	var err error
	switch {
	case link.ViaBot:
		err = n.API.EditChannelMessage(ctx, link.ChannelID, link.MessageID, message)
	case n.now().Before(link.TokenExpiresAt):
		err = n.API.EditFollowup(ctx, link.InteractionToken, link.MessageID, message)
	default:
		return
	}
	if err != nil {
		slog.ErrorContext(ctx, "discord card edit failed", "room_id", roomID, "error", err)
	}
}

func (n *Notifier) message(ctx context.Context, roomID string, link *Link) (map[string]any, error) {
	card, err := n.Cards.Card(ctx, roomID)
	if err != nil {
		return nil, err
	}
	people := "Ninguém ainda"
	if len(card.Members) > 0 {
		shown := card.Members
		if len(shown) > cardNames {
			shown = shown[:cardNames]
		}
		people = strings.Join(shown, ", ")
		if extra := len(card.Members) - len(shown); extra > 0 {
			people += fmt.Sprintf(" e mais %d", extra)
		}
	}
	fields := []any{map[string]any{"name": "Na sala", "value": people}}
	if card.Playing != "" {
		fields = append(fields, map[string]any{"name": "Passando", "value": card.Playing})
	}
	return map[string]any{
		"embeds": []any{map[string]any{"title": cardTitle(link), "fields": fields}},
		"components": []any{map[string]any{
			"type": componentRow,
			"components": []any{
				map[string]any{"type": componentButton, "style": buttonLink, "label": "Entrar", "url": n.Origin + "/room/" + roomID},
				map[string]any{"type": componentButton, "style": buttonSecondary, "label": "Copiar link", "custom_id": "copy:" + roomID},
			},
		}},
	}, nil
}

func cardTitle(link *Link) string {
	title := link.Name
	if title == "" {
		title = "Sala"
	}
	if link.Locked {
		title = "🔒 " + title
	}
	return title
}

// run does one card operation off the caller's goroutine, one at a time per room.
func (n *Notifier) run(roomID string, operation func(ctx context.Context)) {
	n.mu.Lock()
	if n.locks == nil {
		n.locks = make(map[string]*stdsync.Mutex)
	}
	lock := n.locks[roomID]
	if lock == nil {
		lock = &stdsync.Mutex{}
		n.locks[roomID] = lock
	}
	n.mu.Unlock()
	go func() {
		lock.Lock()
		defer lock.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), callTimeout)
		defer cancel()
		operation(ctx)
	}()
}

func (n *Notifier) now() time.Time {
	if n.Now != nil {
		return n.Now()
	}
	return time.Now()
}

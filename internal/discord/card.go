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

// Card is what the room card shows: its name, its door, who is in, and what
// is playing. Image is a public picture of what is playing, if there is one.
type Card struct {
	Name    string
	Door    string
	Members []string
	Playing string
	Image   string
}

// The doors a room may have, as room.Access names them.
const (
	DoorOpen     = "open"
	DoorPassword = "password"
	DoorApproval = "approval"
)

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
			n.edit(ctx, roomID, link, closedCard(link))
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
//
// A card posted before the move to components still has its embed, and the
// edit that turns it over must clear it, each API in its own way.
func (n *Notifier) edit(ctx context.Context, roomID string, link *Link, message map[string]any) {
	var err error
	switch {
	case link.ViaBot:
		message["content"], message["embeds"] = nil, []any{}
		err = n.API.EditChannelMessage(ctx, link.ChannelID, link.MessageID, message)
	case n.now().Before(link.TokenExpiresAt):
		message["content"], message["embeds"] = nil, nil
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
	return n.roomCard(roomID, link, card), nil
}

// The pieces the card is built from: a message with components V2.
const (
	flagComponentsV2 = 1 << 15

	componentSection   = 9
	componentText      = 10
	componentThumbnail = 11
	componentSeparator = 14
	componentContainer = 17

	// cardAccent is juntos' orange; a closed room goes grey.
	cardAccent       = 0xFF7A45
	cardClosedAccent = 0x4F545C
)

// cardLogo is juntos' icon, served by the site itself.
func cardLogo(origin string) string {
	return origin + "/icon-512.png"
}

// roomCard is the live card: the room's name and door beside the logo, what
// is playing, who is in, and the buttons to join.
func (n *Notifier) roomCard(roomID string, link *Link, card Card) map[string]any {
	header := []any{text("## " + escapeMarkdown(cardName(link, card)))}
	if door := doorLabel(cardDoor(link, card)); door != "" {
		header = append(header, text(door))
	}
	parts := []any{
		section(header, thumbnail(cardLogo(n.Origin), "juntos")),
		map[string]any{"type": componentSeparator, "divider": true, "spacing": 1},
	}
	if card.Playing != "" {
		playing := text("▶️ **" + escapeMarkdown(card.Playing) + "**")
		if card.Image != "" {
			parts = append(parts, section([]any{playing}, thumbnail(card.Image, card.Playing)))
		} else {
			parts = append(parts, playing)
		}
	}
	parts = append(parts, text(membersLine(card.Members)), map[string]any{
		"type": componentRow,
		"components": []any{
			map[string]any{"type": componentButton, "style": buttonLink, "label": "Entrar", "url": n.Origin + "/room/" + roomID},
			map[string]any{"type": componentButton, "style": buttonSecondary, "label": "Copiar link", "custom_id": "copy:" + roomID},
		},
	})
	return cardMessage(cardAccent, parts)
}

// closedCard is what the card turns into when its room closes: no buttons.
func closedCard(link *Link) map[string]any {
	return cardMessage(cardClosedAccent, []any{
		text("## " + escapeMarkdown(cardName(link, Card{}))),
		text("Sala encerrada"),
	})
}

// cardMessage wraps the parts in the accented container. The names on the
// card are typed by the room's members, so nothing on it may ping anyone.
func cardMessage(accent int, parts []any) map[string]any {
	return map[string]any{
		"flags":            flagComponentsV2,
		"allowed_mentions": map[string]any{"parse": []any{}},
		"components": []any{map[string]any{
			"type":         componentContainer,
			"accent_color": accent,
			"components":   parts,
		}},
	}
}

func text(content string) map[string]any {
	return map[string]any{"type": componentText, "content": content}
}

func section(texts []any, accessory map[string]any) map[string]any {
	return map[string]any{"type": componentSection, "components": texts, "accessory": accessory}
}

func thumbnail(url, description string) map[string]any {
	return map[string]any{"type": componentThumbnail, "media": map[string]any{"url": url}, "description": description}
}

func membersLine(members []string) string {
	line := fmt.Sprintf("👥 **%d**", len(members))
	if len(members) == 0 {
		return line
	}
	shown := members
	if len(shown) > cardNames {
		shown = shown[:cardNames]
	}
	names := make([]string, len(shown))
	for i, name := range shown {
		names[i] = escapeMarkdown(name)
	}
	line += " · " + strings.Join(names, ", ")
	if extra := len(members) - len(shown); extra > 0 {
		line += fmt.Sprintf(" e mais %d", extra)
	}
	return line
}

func cardName(link *Link, card Card) string {
	switch {
	case card.Name != "":
		return card.Name
	case link.Name != "":
		return link.Name
	default:
		return "Sala"
	}
}

// cardDoor prefers the room's door as it is now; the link only knows whether
// the command set a password.
func cardDoor(link *Link, card Card) string {
	switch {
	case card.Door != "":
		return card.Door
	case link.Locked:
		return DoorPassword
	default:
		return DoorOpen
	}
}

func doorLabel(door string) string {
	switch door {
	case DoorOpen:
		return "🔓 Aberta"
	case DoorPassword:
		return "🔒 Senha"
	case DoorApproval:
		return "✋ Aprovação"
	default:
		return ""
	}
}

// markdownMarks is every character Discord's markdown gives a meaning to,
// links and mentions included.
const markdownMarks = "\\`*_~|>#-+=[]()<@:!./"

// escapeMarkdown makes a name show as typed: each mark is escaped, so
// "[x](https://…)" stays text instead of turning into a link, and line breaks
// become spaces so a name cannot open a heading or a quote of its own.
func escapeMarkdown(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == '\n' || r == '\r':
			b.WriteByte(' ')
		case strings.ContainsRune(markdownMarks, r):
			b.WriteByte('\\')
			b.WriteRune(r)
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
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

package discord

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// Link is what ties a room to the Discord conversation it was made in: where
// its card goes, and how the app may still write there.
type Link struct {
	ChannelID string `json:"channelId"`
	GuildID   string `json:"guildId,omitempty"`
	// InteractionToken lets the app post and edit in the channel without a
	// bot there, until TokenExpiresAt.
	InteractionToken string    `json:"interactionToken"`
	TokenExpiresAt   time.Time `json:"tokenExpiresAt"`
	// GuildInstalled is the app installed on the server itself, so the bot
	// may write to the channel for as long as the room lives.
	GuildInstalled bool   `json:"guildInstalled,omitempty"`
	Name           string `json:"name,omitempty"`
	Locked         bool   `json:"locked,omitempty"`
	// MessageID is the card once posted; ViaBot says which API posted it,
	// since only that one may edit it.
	MessageID string `json:"messageId,omitempty"`
	ViaBot    bool   `json:"viaBot,omitempty"`
}

// linkTTL outlives any room, so a card can still be closed when its room is.
const linkTTL = 24 * time.Hour

var ErrNoLink = errors.New("room has no discord link")

// LinkStore keeps each room's Link in Redis.
type LinkStore struct {
	rdb *redis.Client
}

func NewLinkStore(rdb *redis.Client) *LinkStore {
	return &LinkStore{rdb: rdb}
}

func linkKey(roomID string) string { return "discord:room:" + roomID }

func (s *LinkStore) Put(ctx context.Context, roomID string, link Link) error {
	raw, err := json.Marshal(link)
	if err != nil {
		return fmt.Errorf("marshal discord link: %w", err)
	}
	return s.rdb.Set(ctx, linkKey(roomID), raw, linkTTL).Err()
}

func (s *LinkStore) Get(ctx context.Context, roomID string) (*Link, error) {
	raw, err := s.rdb.Get(ctx, linkKey(roomID)).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, ErrNoLink
	}
	if err != nil {
		return nil, fmt.Errorf("get discord link: %w", err)
	}
	var link Link
	if err := json.Unmarshal(raw, &link); err != nil {
		return nil, fmt.Errorf("unmarshal discord link: %w", err)
	}
	return &link, nil
}

func (s *LinkStore) Delete(ctx context.Context, roomID string) error {
	return s.rdb.Del(ctx, linkKey(roomID)).Err()
}

package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	gonanoid "github.com/matoous/go-nanoid/v2"
	"github.com/redis/go-redis/v9"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/discord"
	"github.com/giulianoo0/ss/internal/room"
	syncapi "github.com/giulianoo0/ss/internal/sync"
)

// WithDiscord mounts the Discord app's interactions endpoint; nil leaves it out.
func WithDiscord(handler http.Handler) ServerOption {
	return func(o *serverOptions) { o.discord = handler }
}

// discordCardDebounce gathers a burst of arrivals into one edit of the card.
const discordCardDebounce = 10 * time.Second

// DiscordApp wires the Discord app when it is configured: the hub starts
// telling the card about the rooms, and the returned handler serves the
// interactions. Without the app's id and key it returns nil.
func DiscordApp(cfg config.Config, store *room.Store, rdb *redis.Client, hub *syncapi.Hub) http.Handler {
	if !cfg.DiscordEnabled() {
		return nil
	}
	rooms := NewDiscordRooms(store, cfg)
	links := discord.NewLinkStore(rdb)
	hub.SetActivityNotifier(&discord.Notifier{
		API:      &discord.API{Base: cfg.DiscordAPIBase, AppID: cfg.DiscordAppID, BotToken: cfg.DiscordBotToken, Client: &http.Client{Timeout: 10 * time.Second}},
		Links:    links,
		Cards:    rooms,
		Origin:   cfg.PublicOrigin,
		Debounce: discordCardDebounce,
	})
	return &discord.Handler{PublicKey: cfg.DiscordPublicKey, Rooms: rooms, Links: links, Origin: cfg.PublicOrigin}
}

// NewDiscordRooms is the room service the Discord app opens rooms through and
// reads its cards from.
func NewDiscordRooms(store *room.Store, cfg config.Config) interface {
	discord.RoomCreator
	discord.CardSource
} {
	return discordRooms{store: store, cfg: cfg}
}

type discordRooms struct {
	store *room.Store
	cfg   config.Config
}

// CreateRoom opens an empty room the way POST /api/rooms does, with the one
// who ran the command as its host, and the password as its door.
func (d discordRooms) CreateRoom(ctx context.Context, request discord.NewRoom) (discord.CreatedRoom, error) {
	nickname := request.Nickname
	if !validDisplayName(nickname) {
		nickname = ""
	}
	nickname, err := displayNameOrRandom(nickname)
	if err != nil {
		return discord.CreatedRoom{}, err
	}
	access := room.Access{Mode: room.JoinOpen}
	if request.Password != "" {
		if len(request.Password) > maxPasswordBytes {
			return discord.CreatedRoom{}, errors.New("password too long")
		}
		hash, err := room.HashPassword(request.Password)
		if err != nil {
			return discord.CreatedRoom{}, err
		}
		access = room.Access{Mode: room.JoinPassword, PasswordHash: hash}
	}
	id, err := gonanoid.Generate(roomIDAlphabet, roomIDLength)
	if err != nil {
		return discord.CreatedRoom{}, err
	}
	ownerToken, err := gonanoid.New(32)
	if err != nil {
		return discord.CreatedRoom{}, err
	}
	now := time.Now()
	member := room.Member{ID: "m1", Nickname: nickname, JoinedAt: now}
	if err := d.store.CreateWithMember(ctx, &room.Room{
		ID:           id,
		Name:         discordRoomName(request.Name),
		Status:       room.StatusEmpty,
		ControllerID: member.ID,
		OwnerToken:   ownerToken,
		CreatedAt:    now,
		ExpiresAt:    now.Add(time.Duration(d.cfg.RoomTTLHours) * time.Hour),
	}, member); err != nil {
		return discord.CreatedRoom{}, fmt.Errorf("create discord room: %w", err)
	}
	if err := d.store.SetAccess(ctx, id, access); err != nil {
		return discord.CreatedRoom{}, fmt.Errorf("set discord room access: %w", err)
	}
	return discord.CreatedRoom{ID: id, OwnerToken: ownerToken}, nil
}

// discordRoomName keeps the command's name when it fits a room's name.
func discordRoomName(name string) string {
	name = strings.TrimSpace(name)
	if name == "" || !validRoomText(name, maxRoomNameBytes) {
		return ""
	}
	return name
}

// Card is who is in the room and what it is playing, for the Discord card.
func (d discordRooms) Card(ctx context.Context, roomID string) (discord.Card, error) {
	storedRoom, err := d.store.Get(ctx, roomID)
	if err != nil {
		return discord.Card{}, err
	}
	members, err := d.store.Members(ctx, roomID)
	if err != nil {
		return discord.Card{}, err
	}
	card := discord.Card{Playing: storedRoom.FileName}
	for _, member := range members {
		card.Members = append(card.Members, member.Nickname)
	}
	return card, nil
}

func registerDiscordRoute(r *gin.Engine, handler http.Handler) {
	if handler == nil {
		return
	}
	r.POST("/api/discord/interactions", gin.WrapH(handler))
}

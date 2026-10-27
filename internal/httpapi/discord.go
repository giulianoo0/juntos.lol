package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	gonanoid "github.com/matoous/go-nanoid/v2"
	"github.com/redis/go-redis/v9"

	"github.com/giulianoo0/ss/internal/account"
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
func DiscordApp(cfg config.Config, store *room.Store, rdb *redis.Client, hub *syncapi.Hub, accounts *account.Store) http.Handler {
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
	handler := &discord.Handler{PublicKey: cfg.DiscordPublicKey, Rooms: rooms, Links: links, Origin: cfg.PublicOrigin}
	if accounts != nil {
		handler.Friends = DiscordFriends(accounts)
	}
	return handler
}

// DiscordFriends answers friend requests from the buttons of their DM.
func DiscordFriends(accounts *account.Store) discord.FriendAnswerer {
	return discordFriends{accounts: accounts}
}

type discordFriends struct{ accounts *account.Store }

// AnswerFriend takes the click only from the account the request was sent
// to, found by the Discord user who clicked; the ids in the button only say
// which request.
func (d discordFriends) AnswerFriend(ctx context.Context, discordUserID string, to, from int64, accept bool) (discord.FriendAnswer, error) {
	me, err := d.accounts.ByDiscord(ctx, discordUserID)
	if errors.Is(err, account.ErrNotFound) || (err == nil && me.ID != to) {
		return discord.FriendAnswer{}, discord.ErrNotYours
	}
	if err != nil {
		return discord.FriendAnswer{}, err
	}
	answer := discord.FriendAnswer{Number: from}
	asker, err := d.accounts.Get(ctx, from)
	switch {
	case errors.Is(err, account.ErrNotFound):
		answer.From, answer.Outcome = "#"+strconv.FormatInt(from, 10), discord.FriendGone
		return answer, nil
	case err != nil:
		return discord.FriendAnswer{}, err
	}
	answer.From = asker.Nickname
	if accept {
		err, answer.Outcome = d.accounts.AcceptFriend(ctx, me.ID, from), discord.FriendAccepted
	} else {
		err, answer.Outcome = d.accounts.DeclineFriend(ctx, me.ID, from), discord.FriendDeclined
	}
	if errors.Is(err, account.ErrNoRequest) {
		friends, err := d.accounts.AreFriends(ctx, me.ID, from)
		if err != nil {
			return discord.FriendAnswer{}, err
		}
		answer.Outcome = discord.FriendGone
		if friends {
			answer.Outcome = discord.FriendAlready
		}
		return answer, nil
	}
	return answer, err
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

// Card is the room's name and door, who is in, and what it is playing, for
// the Discord card. A live shows its YouTube thumbnail.
func (d discordRooms) Card(ctx context.Context, roomID string) (discord.Card, error) {
	storedRoom, err := d.store.Get(ctx, roomID)
	if err != nil {
		return discord.Card{}, err
	}
	members, err := d.store.Members(ctx, roomID)
	if err != nil {
		return discord.Card{}, err
	}
	card := discord.Card{Name: storedRoom.Name, Door: storedRoom.JoinMode, Playing: storedRoom.FileName}
	if live := storedRoom.Live; card.Playing == "" && live != nil && live.Title != "" {
		card.Playing = live.Title
		if youtubeIDRe.MatchString(live.VideoID) {
			card.Image = "https://i.ytimg.com/vi/" + live.VideoID + "/hqdefault.jpg"
		}
	}
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

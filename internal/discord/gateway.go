package discord

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Statuses Discord reports for a member.
const (
	StatusOnline  = "online"
	StatusIdle    = "idle"
	StatusDND     = "dnd"
	StatusOffline = "offline"
)

const (
	gatewayURL       = "wss://gateway.discord.gg/?v=10&encoding=json"
	intentGuilds     = 1 << 0
	intentPresences  = 1 << 8
	closeBadIntents  = 4014
	closeBadToken    = 4004
	maxGatewayBuffer = 8 << 20
)

// PresenceChange is one member's status moving.
type PresenceChange struct {
	UserID string
	Status string
	Avatar string
}

// Presences keeps, through the bot's gateway connection, the status of the
// members of one server. It only reads: the bot never shows itself online
// for anything but the connection itself.
type Presences struct {
	Token   string
	GuildID string
	// URL overrides the gateway, for tests.
	URL string
	// OnChange hears each status that moves; it must not block.
	OnChange func(PresenceChange)

	mu       sync.RWMutex
	statuses map[string]string
	avatars  map[string]string
}

// Status is the member's status, offline when unknown.
func (p *Presences) Status(userID string) string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if status, ok := p.statuses[userID]; ok {
		return status
	}
	return StatusOffline
}

// Avatar is the member's avatar hash, as the gateway last said it.
func (p *Presences) Avatar(userID string) string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.avatars[userID]
}

func (p *Presences) set(userID, status, avatar string) {
	if userID == "" {
		return
	}
	switch status {
	case StatusOnline, StatusIdle, StatusDND:
	default:
		status = StatusOffline
	}
	p.mu.Lock()
	if p.statuses == nil {
		p.statuses = map[string]string{}
		p.avatars = map[string]string{}
	}
	before := p.statuses[userID]
	if before == "" {
		before = StatusOffline
	}
	if status == StatusOffline {
		delete(p.statuses, userID)
	} else {
		p.statuses[userID] = status
	}
	avatarChanged := false
	if avatar != "" && p.avatars[userID] != avatar {
		p.avatars[userID] = avatar
		avatarChanged = true
	}
	p.mu.Unlock()
	if (before != status || avatarChanged) && p.OnChange != nil {
		p.OnChange(PresenceChange{UserID: userID, Status: status, Avatar: avatar})
	}
}

// Run keeps the connection up until ctx ends, reconnecting with backoff.
func (p *Presences) Run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		started := time.Now()
		err := p.session(ctx)
		if ctx.Err() != nil {
			return
		}
		var closed *websocket.CloseError
		wait := backoff
		if errors.As(err, &closed) && (closed.Code == closeBadIntents || closed.Code == closeBadToken) {
			// Nothing a retry fixes soon: the Presence intent is off or the token is wrong.
			slog.WarnContext(ctx, "discord gateway refused", "code", closed.Code, "text", closed.Text)
			wait = 15 * time.Minute
		} else {
			slog.InfoContext(ctx, "discord gateway closed", "error", err)
		}
		if time.Since(started) > time.Minute {
			backoff = time.Second
		} else if backoff < 2*time.Minute {
			backoff *= 2
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait + time.Duration(rand.Int64N(int64(time.Second)))):
		}
	}
}

type gatewayFrame struct {
	Op int             `json:"op"`
	D  json.RawMessage `json:"d"`
	S  *int64          `json:"s"`
	T  string          `json:"t"`
}

type presenceUpdate struct {
	User struct {
		ID     string `json:"id"`
		Avatar string `json:"avatar"`
	} `json:"user"`
	GuildID string `json:"guild_id"`
	Status  string `json:"status"`
}

func (p *Presences) session(ctx context.Context) error {
	url := p.URL
	if url == "" {
		url = gatewayURL
	}
	dialer := websocket.Dialer{HandshakeTimeout: 15 * time.Second}
	conn, _, err := dialer.DialContext(ctx, url, nil)
	if err != nil {
		return err
	}
	defer conn.Close()
	conn.SetReadLimit(maxGatewayBuffer)
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()

	var writeMu sync.Mutex
	write := func(v any) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		return conn.WriteJSON(v)
	}

	var hello gatewayFrame
	if err := conn.ReadJSON(&hello); err != nil {
		return err
	}
	var helloData struct {
		HeartbeatInterval int64 `json:"heartbeat_interval"`
	}
	if hello.Op != 10 || json.Unmarshal(hello.D, &helloData) != nil || helloData.HeartbeatInterval <= 0 {
		return errors.New("discord gateway: no hello")
	}
	interval := time.Duration(helloData.HeartbeatInterval) * time.Millisecond

	var seqMu sync.Mutex
	var seq *int64
	acked := true
	heartbeat := func() error {
		seqMu.Lock()
		if !acked {
			seqMu.Unlock()
			return errors.New("discord gateway: heartbeat not acknowledged")
		}
		acked = false
		last := seq
		seqMu.Unlock()
		return write(map[string]any{"op": 1, "d": last})
	}
	beatDone := make(chan struct{})
	defer close(beatDone)
	go func() {
		timer := time.NewTimer(time.Duration(rand.Float64() * float64(interval)))
		defer timer.Stop()
		for {
			select {
			case <-beatDone:
				return
			case <-timer.C:
				if err := heartbeat(); err != nil {
					_ = conn.Close()
					return
				}
				timer.Reset(interval)
			}
		}
	}()

	identify := map[string]any{
		"op": 2,
		"d": map[string]any{
			"token":           p.Token,
			"intents":         intentGuilds | intentPresences,
			"large_threshold": 250,
			"properties":      map[string]string{"os": "linux", "browser": "juntos", "device": "juntos"},
			"presence":        map[string]any{"status": "online", "afk": false, "activities": []any{}},
		},
	}
	if err := write(identify); err != nil {
		return err
	}

	for {
		_ = conn.SetReadDeadline(time.Now().Add(interval + 30*time.Second))
		var frame gatewayFrame
		if err := conn.ReadJSON(&frame); err != nil {
			return err
		}
		if frame.S != nil {
			seqMu.Lock()
			seq = frame.S
			seqMu.Unlock()
		}
		switch frame.Op {
		case 11:
			seqMu.Lock()
			acked = true
			seqMu.Unlock()
		case 1:
			seqMu.Lock()
			last := seq
			seqMu.Unlock()
			if err := write(map[string]any{"op": 1, "d": last}); err != nil {
				return err
			}
		case 7:
			return errors.New("discord gateway: asked to reconnect")
		case 9:
			return errors.New("discord gateway: invalid session")
		case 0:
			p.dispatch(frame)
		}
	}
}

func (p *Presences) dispatch(frame gatewayFrame) {
	switch frame.T {
	case "GUILD_CREATE":
		var guild struct {
			ID        string           `json:"id"`
			Presences []presenceUpdate `json:"presences"`
			Members   []struct {
				User struct {
					ID     string `json:"id"`
					Avatar string `json:"avatar"`
				} `json:"user"`
			} `json:"members"`
		}
		if json.Unmarshal(frame.D, &guild) != nil || guild.ID != p.GuildID {
			return
		}
		avatars := map[string]string{}
		for _, member := range guild.Members {
			avatars[member.User.ID] = member.User.Avatar
		}
		p.mu.Lock()
		p.statuses = map[string]string{}
		if p.avatars == nil {
			p.avatars = map[string]string{}
		}
		p.mu.Unlock()
		for _, presence := range guild.Presences {
			avatar := presence.User.Avatar
			if avatar == "" {
				avatar = avatars[presence.User.ID]
			}
			p.set(presence.User.ID, presence.Status, avatar)
		}
	case "PRESENCE_UPDATE":
		var presence presenceUpdate
		if json.Unmarshal(frame.D, &presence) != nil || presence.GuildID != p.GuildID {
			return
		}
		p.set(presence.User.ID, presence.Status, presence.User.Avatar)
	}
}

package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	stdsync "sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"github.com/giulianoo0/ss/internal/account"
	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/tv"
)

const (
	tvPairsPerHour   = 20
	maxTVSocketBytes = 8 << 10
	tvPongWait       = 60 * time.Second
	tvPingPeriod     = 30 * time.Second
	tvWriteWait      = 10 * time.Second
)

// TVAccess is where TVs are kept: the linked devices, the pairings under
// way and each TV's mix.
type TVAccess struct {
	Devices *tv.Devices
	Pairs   *tv.Pairs
	Mixes   *tv.Mixes
}

// TVRooms is the hub's part in casting: who is in which room, and the
// ticket that lets a TV through a room's password.
type TVRooms interface {
	PresenceSource
	MintTicket(roomID string) string
}

// WithTV mounts pairing and casting to TVs; it needs WithAccounts too.
func WithTV(access TVAccess) ServerOption {
	return func(o *serverOptions) { o.tv = &access }
}

type tvRoutes struct {
	cfg      config.Config
	accounts *account.Store
	access   TVAccess
	rooms    TVRooms
	login    *accountRoutes
	pairs    *windowLimiter
	sockets  *tvSockets
}

// RegisterTVRoutes mounts the TV API and the TV's own socket, /ws/tv.
func RegisterTVRoutes(r *gin.Engine, cfg config.Config, accounts *account.Store, access TVAccess, rooms TVRooms) {
	routes := &tvRoutes{
		cfg: cfg, accounts: accounts, access: access, rooms: rooms,
		login:   &accountRoutes{cfg: cfg, accounts: accounts},
		pairs:   newWindowLimiter(tvPairsPerHour, time.Hour),
		sockets: &tvSockets{byDevice: make(map[string]*tvSocket)},
	}
	device := r.Group("/api/tv")
	device.POST("/pair", routes.startPair)
	device.GET("/pair/:pairId", routes.pollPair)
	device.GET("/me", routes.me)
	owner := r.Group("/api/tv", sameOrigin(cfg))
	owner.POST("/link", routes.link)
	owner.GET("/devices", routes.devices)
	owner.PATCH("/devices/:id", routes.rename)
	owner.DELETE("/devices/:id", routes.unlink)
	owner.POST("/devices/:id/cast", routes.cast)
	owner.POST("/devices/:id/stop", routes.stop)
	owner.PUT("/devices/:id/mix", routes.setMix)
	r.GET("/ws/tv", routes.socket)
}

// TVOrHuman lets a TV with a live token past the human check: a TV can't
// solve Turnstile, and its token already proves an account linked it.
func TVOrHuman(devices *tv.Devices, gate gin.HandlerFunc) gin.HandlerFunc {
	return func(c *gin.Context) {
		if token := c.Query("tv"); token != "" && devices != nil {
			if _, err := devices.ByToken(c.Request.Context(), token); err == nil {
				c.Next()
				return
			}
		}
		gate(c)
	}
}

type tvDeviceView struct {
	ID     string  `json:"id"`
	Name   string  `json:"name"`
	Online bool    `json:"online"`
	RoomID string  `json:"roomId,omitempty"`
	Mix    *tv.Mix `json:"mix,omitempty"`
}

func deviceCard(d tv.Device) tv.DeviceCard { return tv.DeviceCard{ID: d.ID, Name: d.Name} }

func tvAccountCard(a account.Account) tv.AccountCard {
	return tv.AccountCard{ID: a.ID, Nickname: a.Nickname, Avatar: a.Avatar}
}

func (t *tvRoutes) startPair(c *gin.Context) {
	if !t.pairs.allow(requestIP(c.Request, t.cfg.BehindCloudflare)) {
		c.JSON(http.StatusTooManyRequests, gin.H{"error": "too_many_pairs"})
		return
	}
	pair, err := t.access.Pairs.Start(c.Request.Context())
	if err != nil {
		slog.ErrorContext(c.Request.Context(), "start tv pair", "error", err)
		c.Status(http.StatusInternalServerError)
		return
	}
	c.JSON(http.StatusOK, gin.H{"pairId": pair.ID, "code": pair.Code, "expiresAt": pair.ExpiresAt.UTC()})
}

func (t *tvRoutes) pollPair(c *gin.Context) {
	linked, err := t.access.Pairs.Poll(c.Request.Context(), c.Param("pairId"))
	switch {
	case errors.Is(err, tv.ErrPending):
		c.JSON(http.StatusOK, gin.H{"status": "pending"})
	case errors.Is(err, tv.ErrNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "pair_not_found"})
	case err != nil:
		c.Status(http.StatusInternalServerError)
	default:
		c.JSON(http.StatusOK, gin.H{"status": "linked", "token": linked.Token, "device": linked.Device, "account": linked.Account})
	}
}

func (t *tvRoutes) link(c *gin.Context) {
	me, ok := t.login.viewer(c, true)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxAccountBody)
	var request struct {
		Code string `json:"code"`
	}
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	ctx := c.Request.Context()
	pairID, err := t.access.Pairs.Claim(ctx, request.Code)
	if errors.Is(err, tv.ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "code_not_found"})
		return
	}
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return
	}
	device, token, err := t.access.Devices.Create(ctx, me.ID, "")
	if err != nil {
		slog.ErrorContext(ctx, "create tv device", "error", err)
		c.Status(http.StatusInternalServerError)
		return
	}
	err = t.access.Pairs.Complete(ctx, pairID, tv.Linked{Token: token, Device: deviceCard(device), Account: tvAccountCard(me)})
	if err != nil {
		// The TV stopped waiting: nobody can ever use this device.
		_ = t.access.Devices.Delete(context.WithoutCancel(ctx), me.ID, device.ID)
		if errors.Is(err, tv.ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "code_not_found"})
			return
		}
		c.Status(http.StatusInternalServerError)
		return
	}
	c.JSON(http.StatusOK, gin.H{"device": deviceCard(device)})
}

func (t *tvRoutes) devices(c *gin.Context) {
	me, ok := t.login.viewer(c, true)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	devices, err := t.access.Devices.List(ctx, me.ID)
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return
	}
	views := make([]tvDeviceView, 0, len(devices))
	for _, device := range devices {
		mix, err := t.access.Mixes.Get(ctx, device.ID)
		if err != nil {
			c.Status(http.StatusInternalServerError)
			return
		}
		online, roomID := t.sockets.status(device.ID)
		views = append(views, tvDeviceView{ID: device.ID, Name: device.Name, Online: online, RoomID: roomID, Mix: &mix})
	}
	c.JSON(http.StatusOK, gin.H{"devices": views})
}

// owned is the account's device named in the path; ok is false once the
// refusal is written.
func (t *tvRoutes) owned(c *gin.Context) (account.Account, tv.Device, bool) {
	me, ok := t.login.viewer(c, true)
	if !ok {
		return account.Account{}, tv.Device{}, false
	}
	device, err := t.access.Devices.Get(c.Request.Context(), me.ID, c.Param("id"))
	if errors.Is(err, tv.ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "device_not_found"})
		return account.Account{}, tv.Device{}, false
	}
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return account.Account{}, tv.Device{}, false
	}
	return me, device, true
}

func (t *tvRoutes) rename(c *gin.Context) {
	me, device, ok := t.owned(c)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxAccountBody)
	var request struct {
		Name string `json:"name"`
	}
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	renamed, err := t.access.Devices.Rename(c.Request.Context(), me.ID, device.ID, request.Name)
	if errors.Is(err, tv.ErrInvalidName) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_name"})
		return
	}
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return
	}
	c.JSON(http.StatusOK, gin.H{"device": deviceCard(renamed)})
}

func (t *tvRoutes) unlink(c *gin.Context) {
	me, device, ok := t.owned(c)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	if err := t.access.Devices.Delete(ctx, me.ID, device.ID); err != nil && !errors.Is(err, tv.ErrNotFound) {
		c.Status(http.StatusInternalServerError)
		return
	}
	if err := t.access.Mixes.Drop(ctx, device.ID); err != nil {
		slog.WarnContext(ctx, "drop tv mix", "error", err)
	}
	t.sockets.revoke(device.ID)
	c.Status(http.StatusNoContent)
}

func (t *tvRoutes) cast(c *gin.Context) {
	me, device, ok := t.owned(c)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxAccountBody)
	var request struct {
		RoomID string `json:"roomId"`
	}
	if err := c.ShouldBindJSON(&request); err != nil || request.RoomID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	if t.rooms == nil || t.rooms.Presence([]int64{me.ID})[me.ID] != request.RoomID {
		c.JSON(http.StatusConflict, gin.H{"error": "not_in_room"})
		return
	}
	roomID := request.RoomID
	if !t.sockets.push(device.ID, tvMessage{Type: "cast", RoomID: &roomID, Ticket: t.rooms.MintTicket(roomID)}) {
		c.JSON(http.StatusConflict, gin.H{"error": "tv_offline"})
		return
	}
	c.Status(http.StatusNoContent)
}

func (t *tvRoutes) stop(c *gin.Context) {
	_, device, ok := t.owned(c)
	if !ok {
		return
	}
	t.sockets.push(device.ID, tvMessage{Type: "stop"})
	c.Status(http.StatusNoContent)
}

func (t *tvRoutes) setMix(c *gin.Context) {
	_, device, ok := t.owned(c)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxAccountBody)
	var mix tv.Mix
	if err := c.ShouldBindJSON(&mix); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	if !mix.Valid() {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_mix"})
		return
	}
	if mix.People == nil {
		mix.People = map[string]float64{}
	}
	if err := t.access.Mixes.Set(c.Request.Context(), device.ID, mix); err != nil {
		c.Status(http.StatusInternalServerError)
		return
	}
	t.sockets.push(device.ID, tvMessage{Type: "mix", Mix: &mix})
	c.JSON(http.StatusOK, gin.H{"mix": mix})
}

// tvSignedIn is the device and account behind a TV's token; ok is false once
// the refusal is written.
func (t *tvRoutes) tvSignedIn(c *gin.Context, token string) (tv.Device, account.Account, bool) {
	ctx := c.Request.Context()
	device, err := t.access.Devices.ByToken(ctx, token)
	if errors.Is(err, tv.ErrNotFound) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid_token"})
		return tv.Device{}, account.Account{}, false
	}
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return tv.Device{}, account.Account{}, false
	}
	owner, err := t.accounts.Get(ctx, device.AccountID)
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return tv.Device{}, account.Account{}, false
	}
	if err := t.access.Devices.Touch(ctx, device.ID); err != nil {
		slog.WarnContext(ctx, "touch tv device", "error", err)
	}
	return device, owner, true
}

func (t *tvRoutes) me(c *gin.Context) {
	token, found := strings.CutPrefix(c.GetHeader("Authorization"), "Bearer ")
	if !found {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid_token"})
		return
	}
	device, owner, ok := t.tvSignedIn(c, strings.TrimSpace(token))
	if !ok {
		return
	}
	c.JSON(http.StatusOK, gin.H{"device": deviceCard(device), "account": tvAccountCard(owner)})
}

// tvMessage goes either way on /ws/tv.
type tvMessage struct {
	Type string `json:"type"`
	// RoomID on a state is null when the TV left the room.
	RoomID *string `json:"roomId,omitempty"`
	Ticket string  `json:"ticket,omitempty"`
	Mix    *tv.Mix `json:"mix,omitempty"`
}

// The token in the URL is the whole credential: no cookie rides along, so a
// page from another origin gains nothing by opening the socket.
var tvUpgrader = websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}

func (t *tvRoutes) socket(c *gin.Context) {
	device, _, ok := t.tvSignedIn(c, c.Query("token"))
	if !ok {
		return
	}
	conn, err := tvUpgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	socket := &tvSocket{send: make(chan tvMessage, 16), quit: make(chan struct{})}
	t.sockets.attach(device.ID, socket)
	defer t.sockets.detach(device.ID, socket)
	defer socket.stop()
	if mix, err := t.access.Mixes.Get(c.Request.Context(), device.ID); err == nil {
		socket.deliver(tvMessage{Type: "mix", Mix: &mix})
	}
	go socket.writePump(conn)
	conn.SetReadLimit(maxTVSocketBytes)
	_ = conn.SetReadDeadline(time.Now().Add(tvPongWait))
	conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(tvPongWait)) })
	for {
		var message tvMessage
		if err := conn.ReadJSON(&message); err != nil {
			return
		}
		_ = conn.SetReadDeadline(time.Now().Add(tvPongWait))
		switch message.Type {
		case "mix":
			if message.Mix == nil || !message.Mix.Valid() {
				continue
			}
			if err := t.access.Mixes.Set(c.Request.Context(), device.ID, *message.Mix); err != nil {
				slog.WarnContext(c.Request.Context(), "save tv mix", "error", err)
			}
		case "state":
			roomID := ""
			if message.RoomID != nil && validMediaRoomID(*message.RoomID) {
				roomID = *message.RoomID
			}
			t.sockets.setRoom(socket, roomID)
		}
	}
}

// tvSocket is one open /ws/tv; quit ends it from whichever side goes first.
type tvSocket struct {
	send     chan tvMessage
	quit     chan struct{}
	quitOnce stdsync.Once
	roomID   string
}

func (s *tvSocket) stop() { s.quitOnce.Do(func() { close(s.quit) }) }

func (s *tvSocket) deliver(message tvMessage) bool {
	select {
	case s.send <- message:
		return true
	case <-s.quit:
		return false
	default:
		slog.Warn("tv socket send buffer full", "type", message.Type)
		return false
	}
}

func (s *tvSocket) writePump(conn *websocket.Conn) {
	ticker := time.NewTicker(tvPingPeriod)
	defer ticker.Stop()
	defer conn.Close()
	for {
		select {
		case <-s.quit:
			return
		case message := <-s.send:
			_ = conn.SetWriteDeadline(time.Now().Add(tvWriteWait))
			if err := conn.WriteJSON(message); err != nil {
				return
			}
			if message.Type == "revoked" {
				_ = conn.WriteControl(websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "revoked"), time.Now().Add(tvWriteWait))
				return
			}
		case <-ticker.C:
			if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(tvWriteWait)); err != nil {
				return
			}
		}
	}
}

// tvSockets is which TVs are online now, one socket per device: a TV that
// opens a second one is the same TV come back, and the first is let go.
type tvSockets struct {
	mu       stdsync.Mutex
	byDevice map[string]*tvSocket
}

func (s *tvSockets) attach(deviceID string, socket *tvSocket) {
	s.mu.Lock()
	previous := s.byDevice[deviceID]
	s.byDevice[deviceID] = socket
	s.mu.Unlock()
	if previous != nil {
		previous.stop()
	}
}

func (s *tvSockets) detach(deviceID string, socket *tvSocket) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.byDevice[deviceID] == socket {
		delete(s.byDevice, deviceID)
	}
}

func (s *tvSockets) push(deviceID string, message tvMessage) bool {
	s.mu.Lock()
	socket := s.byDevice[deviceID]
	s.mu.Unlock()
	return socket != nil && socket.deliver(message)
}

// revoke tells the TV it was unlinked and lets its socket go.
func (s *tvSockets) revoke(deviceID string) {
	s.mu.Lock()
	socket := s.byDevice[deviceID]
	delete(s.byDevice, deviceID)
	s.mu.Unlock()
	if socket != nil && !socket.deliver(tvMessage{Type: "revoked"}) {
		socket.stop()
	}
}

func (s *tvSockets) setRoom(socket *tvSocket, roomID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	socket.roomID = roomID
}

func (s *tvSockets) status(deviceID string) (online bool, roomID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	socket := s.byDevice[deviceID]
	if socket == nil {
		return false, ""
	}
	return true, socket.roomID
}

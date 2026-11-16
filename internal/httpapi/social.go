package httpapi

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	stdsync "sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"github.com/giulianoo0/ss/internal/account"
	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/discord"
	"github.com/giulianoo0/ss/internal/dm"
)

const (
	inboxWriteWait  = 10 * time.Second
	inboxPongWait   = 60 * time.Second
	inboxPingPeriod = 25 * time.Second
	maxInboxRead    = 4 << 10
	maxDMBody       = 64 << 10
	dmSendsPerMin   = 60
	typingPerMin    = 40
	avatarCacheTTL  = time.Hour
	maxAvatarBytes  = 512 << 10
	maxAvatarCache  = 512
)

// Social is what friends see of each other live: who is online on juntos or
// on Discord, private messages and the calls into rooms, all pushed through
// one socket per open page or app, /ws/inbox.
type Social struct {
	cfg      config.Config
	accounts *account.Store
	dms      *dm.Store
	discord  *discord.Presences
	cdn      *http.Client
	// CDN is Discord's image host, for tests.
	CDN string

	mu      stdsync.Mutex
	sockets map[int64]map[*inboxSocket]struct{}
	avatars map[string]cachedAvatar

	sends  *windowLimiter
	typing *windowLimiter
}

type cachedAvatar struct {
	body        []byte
	contentType string
	until       time.Time
}

func NewSocial(cfg config.Config, accounts *account.Store, dms *dm.Store) *Social {
	return &Social{
		cfg: cfg, accounts: accounts, dms: dms,
		cdn:     &http.Client{Timeout: 10 * time.Second},
		CDN:     "https://cdn.discordapp.com",
		sockets: map[int64]map[*inboxSocket]struct{}{},
		avatars: map[string]cachedAvatar{},
		sends:   newWindowLimiter(dmSendsPerMin, time.Minute),
		typing:  newWindowLimiter(typingPerMin, time.Minute),
	}
}

// WithSocial mounts /ws/inbox and the private messages.
func WithSocial(social *Social) ServerOption {
	return func(o *serverOptions) { o.social = social }
}

// SetDiscord hands over the server's Discord statuses; nil leaves Discord out.
func (s *Social) SetDiscord(presences *discord.Presences) { s.discord = presences }

// Online is whether the account has juntos open somewhere right now.
func (s *Social) Online(accountID int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sockets[accountID]) > 0
}

// DiscordStatus is the account's status on Discord, "" when unknown.
func (s *Social) DiscordStatus(a account.Account) string {
	if s.discord == nil || a.DiscordID == "" {
		return ""
	}
	return s.discord.Status(a.DiscordID)
}

type inboxEvent struct {
	Type    string      `json:"type"`
	ID      int64       `json:"id,omitempty"`
	From    int64       `json:"from,omitempty"`
	UpTo    int64       `json:"upTo,omitempty"`
	Message *dm.Message `json:"message,omitempty"`
}

type inboxSocket struct {
	account  int64
	device   string
	send     chan inboxEvent
	quit     chan struct{}
	quitOnce stdsync.Once
}

func (s *inboxSocket) stop() { s.quitOnce.Do(func() { close(s.quit) }) }

func (s *inboxSocket) deliver(event inboxEvent) {
	select {
	case s.send <- event:
	case <-s.quit:
	default:
		// A socket too slow to drain is closed; the page reconnects and catches up.
		s.stop()
	}
}

// publish sends each socket of the account its own copy of the event.
func (s *Social) publish(accountID int64, event func(device string) inboxEvent) {
	s.mu.Lock()
	targets := make([]*inboxSocket, 0, len(s.sockets[accountID]))
	for socket := range s.sockets[accountID] {
		targets = append(targets, socket)
	}
	s.mu.Unlock()
	for _, socket := range targets {
		socket.deliver(event(socket.device))
	}
}

func (s *Social) tell(accountID int64, event inboxEvent) {
	s.publish(accountID, func(string) inboxEvent { return event })
}

// Notify tells the account's pages that its requests or invites changed.
func (s *Social) Notify(accountID int64) {
	s.tell(accountID, inboxEvent{Type: "notifications"})
}

// FriendsChanged tells the account its friend list moved.
func (s *Social) FriendsChanged(accountID int64) {
	s.tell(accountID, inboxEvent{Type: "friends"})
}

// PresenceChanged tells the account's friends to read its status again.
func (s *Social) PresenceChanged(accountID int64) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		friends, err := s.accounts.Friends(ctx, accountID)
		if err != nil {
			return
		}
		for _, friend := range friends {
			s.tell(friend, inboxEvent{Type: "presence", ID: accountID})
		}
	}()
}

// DiscordChanged is a status move on the server, told to the account's friends.
func (s *Social) DiscordChanged(change discord.PresenceChange) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		owner, err := s.accounts.ByDiscord(ctx, change.UserID)
		if err != nil {
			return
		}
		if change.Avatar != "" && change.Avatar != owner.DiscordAvatar {
			_ = s.accounts.SetDiscordAvatar(ctx, owner.ID, change.Avatar)
		}
		s.PresenceChanged(owner.ID)
	}()
}

func (s *Social) attach(socket *inboxSocket) {
	s.mu.Lock()
	set := s.sockets[socket.account]
	first := len(set) == 0
	if set == nil {
		set = map[*inboxSocket]struct{}{}
		s.sockets[socket.account] = set
	}
	set[socket] = struct{}{}
	s.mu.Unlock()
	if first {
		s.PresenceChanged(socket.account)
	}
}

func (s *Social) detach(socket *inboxSocket) {
	s.mu.Lock()
	set := s.sockets[socket.account]
	delete(set, socket)
	last := len(set) == 0
	if last {
		delete(s.sockets, socket.account)
	}
	s.mu.Unlock()
	if last {
		s.PresenceChanged(socket.account)
	}
}

type socialRoutes struct {
	*Social
	viewer func(c *gin.Context, required bool) (account.Account, bool)
}

func (s *Social) register(r *gin.Engine, viewer func(c *gin.Context, required bool) (account.Account, bool)) {
	routes := &socialRoutes{Social: s, viewer: viewer}
	r.GET("/ws/inbox", routes.socket)
	api := r.Group("/api")
	api.GET("/users/:id/discord-avatar", routes.discordAvatar)
	api.Use(sameOrigin(s.cfg))
	api.POST("/dm/devices", routes.registerDevice)
	api.DELETE("/dm/devices/:device", routes.removeDevice)
	api.GET("/dm/threads", routes.threads)
	api.GET("/dm/since", routes.since)
	api.GET("/dm/with/:id", routes.page)
	api.GET("/dm/with/:id/keys", routes.keys)
	api.POST("/dm/with/:id", routes.sendMessage)
	api.POST("/dm/with/:id/read", routes.markRead)
}

// The cookie signs the socket in, so only the site itself (or an app, which
// sends no Origin) may open it.
func (s *socialRoutes) originAllowed(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	return origin == "" || s.cfg.PublicOrigin == "" || origin == s.cfg.PublicOrigin
}

func (s *socialRoutes) socket(c *gin.Context) {
	me, ok := s.viewer(c, true)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	device := c.Query("device")
	if device != "" {
		owned, err := s.dms.Owns(ctx, me.ID, device)
		if err != nil {
			c.Status(http.StatusInternalServerError)
			return
		}
		if !owned {
			c.JSON(http.StatusConflict, gin.H{"error": "unknown_device"})
			return
		}
	}
	upgrader := websocket.Upgrader{CheckOrigin: s.originAllowed}
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	socket := &inboxSocket{account: me.ID, device: device, send: make(chan inboxEvent, 64), quit: make(chan struct{})}
	s.attach(socket)
	defer s.detach(socket)
	defer socket.stop()
	go socket.writePump(conn)
	socket.deliver(inboxEvent{Type: "hello", ID: me.ID})

	conn.SetReadLimit(maxInboxRead)
	_ = conn.SetReadDeadline(time.Now().Add(inboxPongWait))
	conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(inboxPongWait)) })
	for {
		var message struct {
			Type string `json:"type"`
			To   int64  `json:"to"`
		}
		if err := conn.ReadJSON(&message); err != nil {
			return
		}
		_ = conn.SetReadDeadline(time.Now().Add(inboxPongWait))
		switch message.Type {
		case "ping":
			socket.deliver(inboxEvent{Type: "pong"})
		case "typing":
			if message.To <= 0 || message.To == me.ID || !s.typing.allow(strconv.FormatInt(me.ID, 10)) {
				continue
			}
			friends, err := s.accounts.AreFriends(ctx, me.ID, message.To)
			if err == nil && friends {
				s.tell(message.To, inboxEvent{Type: "typing", From: me.ID})
			}
		}
	}
}

func (s *inboxSocket) writePump(conn *websocket.Conn) {
	ticker := time.NewTicker(inboxPingPeriod)
	defer ticker.Stop()
	defer conn.Close()
	for {
		select {
		case <-s.quit:
			return
		case event := <-s.send:
			_ = conn.SetWriteDeadline(time.Now().Add(inboxWriteWait))
			if err := conn.WriteJSON(event); err != nil {
				s.stop()
				return
			}
		case <-ticker.C:
			if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(inboxWriteWait)); err != nil {
				s.stop()
				return
			}
		}
	}
}

// friend is the account named in the path when it is the viewer's friend; a
// response is already written when ok is false.
func (s *socialRoutes) friend(c *gin.Context) (me account.Account, other int64, ok bool) {
	me, ok = s.viewer(c, true)
	if !ok {
		return account.Account{}, 0, false
	}
	other, ok = accountIDParam(c)
	if !ok {
		return account.Account{}, 0, false
	}
	friends, err := s.accounts.AreFriends(c.Request.Context(), me.ID, other)
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return account.Account{}, 0, false
	}
	if !friends {
		c.JSON(http.StatusForbidden, gin.H{"error": "not_friends"})
		return account.Account{}, 0, false
	}
	return me, other, true
}

// device is the ?device= of the viewer, or a response saying it is unknown.
func (s *socialRoutes) device(c *gin.Context, me account.Account, id string) bool {
	owned, err := s.dms.Owns(c.Request.Context(), me.ID, id)
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return false
	}
	if !owned {
		c.JSON(http.StatusConflict, gin.H{"error": "unknown_device"})
		return false
	}
	return true
}

func (s *socialRoutes) registerDevice(c *gin.Context) {
	me, ok := s.viewer(c, true)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4<<10)
	var body struct {
		PublicKey string `json:"publicKey"`
		Label     string `json:"label"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	device, err := s.dms.RegisterDevice(c.Request.Context(), me.ID, body.PublicKey, body.Label)
	if errors.Is(err, dm.ErrInvalid) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_key"})
		return
	}
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return
	}
	c.JSON(http.StatusOK, device)
}

func (s *socialRoutes) removeDevice(c *gin.Context) {
	me, ok := s.viewer(c, true)
	if !ok {
		return
	}
	if err := s.dms.RemoveDevice(c.Request.Context(), me.ID, c.Param("device")); err != nil {
		c.Status(http.StatusInternalServerError)
		return
	}
	c.Status(http.StatusNoContent)
}

func (s *socialRoutes) keys(c *gin.Context) {
	me, other, ok := s.friend(c)
	if !ok {
		return
	}
	devices, err := s.dms.Devices(c.Request.Context(), me.ID, other)
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return
	}
	c.JSON(http.StatusOK, gin.H{"mine": devices[me.ID], "theirs": devices[other]})
}

func (s *socialRoutes) threads(c *gin.Context) {
	me, ok := s.viewer(c, true)
	if !ok {
		return
	}
	device := c.Query("device")
	if !s.device(c, me, device) {
		return
	}
	threads, err := s.dms.Threads(c.Request.Context(), me.ID, device)
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return
	}
	c.JSON(http.StatusOK, gin.H{"threads": threads})
}

func (s *socialRoutes) since(c *gin.Context) {
	me, ok := s.viewer(c, true)
	if !ok {
		return
	}
	device := c.Query("device")
	if !s.device(c, me, device) {
		return
	}
	after, _ := strconv.ParseInt(c.Query("after"), 10, 64)
	messages, err := s.dms.Since(c.Request.Context(), me.ID, device, after)
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return
	}
	c.JSON(http.StatusOK, gin.H{"messages": messages})
}

func (s *socialRoutes) page(c *gin.Context) {
	me, other, ok := s.friend(c)
	if !ok {
		return
	}
	device := c.Query("device")
	if !s.device(c, me, device) {
		return
	}
	ctx := c.Request.Context()
	before, _ := strconv.ParseInt(c.Query("before"), 10, 64)
	messages, err := s.dms.Page(ctx, me.ID, other, device, before, dm.PageSize)
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return
	}
	theyRead, err := s.dms.TheyRead(ctx, me.ID, other)
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return
	}
	c.JSON(http.StatusOK, gin.H{"messages": messages, "theyRead": theyRead, "more": len(messages) == dm.PageSize})
}

func (s *socialRoutes) sendMessage(c *gin.Context) {
	me, other, ok := s.friend(c)
	if !ok {
		return
	}
	if !s.sends.allow(strconv.FormatInt(me.ID, 10)) {
		c.JSON(http.StatusTooManyRequests, gin.H{"error": "too_many_messages"})
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxDMBody)
	var body struct {
		SenderDevice string                   `json:"senderDevice"`
		ClientID     string                   `json:"clientId"`
		IV           string                   `json:"iv"`
		Body         string                   `json:"body"`
		Keys         map[string]dm.WrappedKey `json:"keys"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	out := dm.Outgoing{From: me.ID, To: other, SenderDevice: body.SenderDevice, ClientID: body.ClientID,
		IV: body.IV, Body: body.Body, Keys: body.Keys}
	sent, err := s.dms.Send(c.Request.Context(), out)
	var stale *dm.StaleDevicesError
	switch {
	case errors.As(err, &stale):
		c.JSON(http.StatusConflict, gin.H{"error": "stale_devices", "mine": stale.Devices[me.ID], "theirs": stale.Devices[other]})
		return
	case errors.Is(err, dm.ErrNoDevice):
		c.JSON(http.StatusConflict, gin.H{"error": "unknown_device"})
		return
	case errors.Is(err, dm.ErrInvalid):
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_message"})
		return
	case err != nil:
		slog.ErrorContext(c.Request.Context(), "send dm", "error", err)
		c.Status(http.StatusInternalServerError)
		return
	}
	push := func(device string) inboxEvent {
		message := dm.For(sent, body.Keys, device)
		return inboxEvent{Type: "dm", Message: &message}
	}
	s.publish(me.ID, push)
	s.publish(other, push)
	c.JSON(http.StatusOK, dm.For(sent, body.Keys, body.SenderDevice))
}

func (s *socialRoutes) markRead(c *gin.Context) {
	me, other, ok := s.friend(c)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1<<10)
	var body struct {
		UpTo int64 `json:"upTo"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || body.UpTo <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	kept, err := s.dms.MarkRead(c.Request.Context(), me.ID, other, body.UpTo)
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return
	}
	s.tell(other, inboxEvent{Type: "read", From: me.ID, UpTo: kept})
	s.tell(me.ID, inboxEvent{Type: "readMine", From: other, UpTo: kept})
	c.Status(http.StatusNoContent)
}

// discordAvatar serves the account's Discord picture to itself and its
// friends, so the Discord id stays on the server.
func (s *socialRoutes) discordAvatar(c *gin.Context) {
	me, ok := s.viewer(c, true)
	if !ok {
		return
	}
	id, ok := accountIDParam(c)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	if id != me.ID {
		friends, err := s.accounts.AreFriends(ctx, me.ID, id)
		if err != nil {
			c.Status(http.StatusInternalServerError)
			return
		}
		if !friends {
			c.Status(http.StatusNotFound)
			return
		}
	}
	owner, err := s.accounts.Get(ctx, id)
	if err != nil || owner.DiscordID == "" {
		c.Status(http.StatusNotFound)
		return
	}
	hash := owner.DiscordAvatar
	if s.discord != nil {
		if live := s.discord.Avatar(owner.DiscordID); live != "" {
			hash = live
		}
	}
	path := discordAvatarPath(owner.DiscordID, hash)
	avatar, err := s.fetchAvatar(ctx, path)
	if err != nil {
		c.Status(http.StatusBadGateway)
		return
	}
	c.Header("Cache-Control", "private, max-age=3600")
	c.Data(http.StatusOK, avatar.contentType, avatar.body)
}

// discordAvatarPath is the CDN path of the picture, or Discord's default
// one for an account that never set any.
func discordAvatarPath(discordID, hash string) string {
	if hash != "" {
		return "/avatars/" + discordID + "/" + hash + ".png?size=128"
	}
	index := uint64(0)
	if id, err := strconv.ParseUint(discordID, 10, 64); err == nil {
		index = (id >> 22) % 6
	}
	return "/embed/avatars/" + strconv.FormatUint(index, 10) + ".png"
}

func (s *Social) fetchAvatar(ctx context.Context, path string) (cachedAvatar, error) {
	now := time.Now()
	s.mu.Lock()
	cached, ok := s.avatars[path]
	s.mu.Unlock()
	if ok && now.Before(cached.until) {
		return cached, nil
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, s.CDN+path, nil)
	if err != nil {
		return cachedAvatar{}, err
	}
	response, err := s.cdn.Do(request)
	if err != nil {
		return cachedAvatar{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return cachedAvatar{}, errors.New("discord cdn: " + response.Status)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxAvatarBytes))
	if err != nil {
		return cachedAvatar{}, err
	}
	contentType := response.Header.Get("Content-Type")
	if contentType != "image/png" && contentType != "image/webp" && contentType != "image/gif" && contentType != "image/jpeg" {
		contentType = "image/png"
	}
	fresh := cachedAvatar{body: body, contentType: contentType, until: now.Add(avatarCacheTTL)}
	s.mu.Lock()
	if len(s.avatars) >= maxAvatarCache {
		for key, old := range s.avatars {
			if now.After(old.until) || len(s.avatars) >= maxAvatarCache {
				delete(s.avatars, key)
			}
		}
	}
	s.avatars[path] = fresh
	s.mu.Unlock()
	return fresh, nil
}

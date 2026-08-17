package sync

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	stdsync "sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
)

const (
	maxWSMessageBytes  = 16 << 10
	maxWSNicknameBytes = 64
	maxChatBytes       = 2 << 10
	storeTimeout       = 5 * time.Second
)

type Hub struct {
	store     *room.Store
	cfg       config.Config
	upgrader  websocket.Upgrader
	idleAfter time.Duration

	mu        stdsync.Mutex
	rooms     map[string]*roomConn
	closed    bool
	ctx       context.Context
	cancel    context.CancelFunc
	closeOnce stdsync.Once
	wg        stdsync.WaitGroup
}

type roomConn struct {
	id           string
	hub          *Hub
	controllerID string
	nextMember   int
	clients      map[string]*client
	register     chan joinRequest
	unregister   chan *client
	inbound      chan clientInbound
	status       chan string
}

type joinRequest struct {
	client       *client
	nickname     string
	clientTimeMs int64
	result       chan string
}

type clientInbound struct {
	client  *client
	message Inbound
}

// NewHub creates a WebSocket hub backed by the room store.
func NewHub(store *room.Store, cfg config.Config) *Hub {
	if cfg.MaxParticipants < 1 {
		cfg.MaxParticipants = 1
	}
	if cfg.RoomIdleMinutes < 1 {
		cfg.RoomIdleMinutes = 1
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Hub{
		store:     store,
		cfg:       cfg,
		idleAfter: time.Duration(cfg.RoomIdleMinutes) * time.Minute,
		rooms:     make(map[string]*roomConn),
		ctx:       ctx,
		cancel:    cancel,
		upgrader: websocket.Upgrader{
			CheckOrigin: sameHostnameOrigin,
		},
	}
}

// Close stops all room and client goroutines owned by the hub.
func (h *Hub) Close() {
	h.closeOnce.Do(func() {
		h.mu.Lock()
		h.closed = true
		h.mu.Unlock()
		h.cancel()
		h.wg.Wait()
	})
}

// HandleWS upgrades and serves GET /ws/rooms/:id.
func (h *Hub) HandleWS(c *gin.Context) {
	roomID := c.Param("id")
	if !validRoomID(roomID) {
		c.Status(http.StatusNotFound)
		return
	}
	storedRoom, err := h.store.Get(c.Request.Context(), roomID)
	if errors.Is(err, room.ErrNotFound) || err == nil && !storedRoom.ExpiresAt.After(time.Now()) {
		c.Status(http.StatusNotFound)
		return
	}
	if err != nil {
		slog.ErrorContext(c.Request.Context(), "load websocket room failed", "room_id", roomID, "error", err)
		c.Status(http.StatusInternalServerError)
		return
	}

	conn, err := h.upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	conn.SetReadLimit(maxWSMessageBytes)
	if err := conn.SetReadDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return
	}
	var hello Inbound
	if err := conn.ReadJSON(&hello); err != nil {
		return
	}
	if err := conn.SetReadDeadline(time.Time{}); err != nil {
		return
	}
	nickname := hello.Nickname
	if nickname == "" {
		nickname = c.Query("nickname")
	}
	if hello.Type != "hello" || !validNickname(nickname) {
		writeHandshakeError(conn, "invalid_hello")
		return
	}

	roomConnection := h.getOrCreateRoom(roomID, storedRoom.ControllerID)
	if roomConnection == nil {
		writeHandshakeError(conn, "server_stopping")
		return
	}
	client := &client{
		conn: conn,
		room: roomConnection,
		send: make(chan Outbound, 64),
	}
	result := make(chan string, 1)
	request := joinRequest{
		client: client, nickname: nickname, clientTimeMs: hello.ClientTimeMs, result: result,
	}
	select {
	case roomConnection.register <- request:
	case <-h.ctx.Done():
		writeHandshakeError(conn, "server_stopping")
		return
	}
	select {
	case errCode := <-result:
		if errCode != "" {
			writeHandshakeError(conn, errCode)
			return
		}
	case <-h.ctx.Done():
		return
	}

	go client.writePump()
	client.readPump()
}

// NotifyStatus broadcasts a persisted room media status to connected clients.
func (h *Hub) NotifyStatus(roomID, status string) {
	h.mu.Lock()
	connection := h.rooms[roomID]
	h.mu.Unlock()
	if connection == nil {
		return
	}
	select {
	case connection.status <- status:
	default:
	}
}

func (h *Hub) getOrCreateRoom(roomID, controllerID string) *roomConn {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return nil
	}
	if existing := h.rooms[roomID]; existing != nil {
		return existing
	}
	connection := &roomConn{
		id:           roomID,
		hub:          h,
		controllerID: controllerID,
		nextMember:   1,
		clients:      make(map[string]*client),
		register:     make(chan joinRequest),
		unregister:   make(chan *client),
		inbound:      make(chan clientInbound),
		status:       make(chan string, 1),
	}
	h.rooms[roomID] = connection
	h.wg.Go(connection.run)
	return connection
}

func (h *Hub) removeRoom(roomID string, connection *roomConn) {
	h.mu.Lock()
	if h.rooms[roomID] == connection {
		delete(h.rooms, roomID)
	}
	h.mu.Unlock()
}

func (r *roomConn) run() {
	defer r.hub.removeRoom(r.id, r)
	defer func() {
		for _, connected := range r.clients {
			close(connected.send)
		}
	}()
	var idleTimer *time.Timer
	var idle <-chan time.Time
	for {
		select {
		case <-r.hub.ctx.Done():
			if idleTimer != nil {
				idleTimer.Stop()
			}
			return
		case request := <-r.register:
			if idleTimer != nil {
				if !idleTimer.Stop() {
					select {
					case <-idleTimer.C:
					default:
					}
				}
				idle = nil
			}
			r.handleJoin(request)
		case disconnected := <-r.unregister:
			r.handleDisconnect(disconnected)
			if len(r.clients) == 0 {
				if idleTimer == nil {
					idleTimer = time.NewTimer(r.hub.idleAfter)
				} else {
					idleTimer.Reset(r.hub.idleAfter)
				}
				idle = idleTimer.C
			}
		case event := <-r.inbound:
			r.handleInbound(event)
		case status := <-r.status:
			r.broadcast(Outbound{Type: "roomStatus", Status: status})
		case <-idle:
			r.cleanupIdle()
			return
		}
	}
}

func (r *roomConn) handleJoin(request joinRequest) {
	if len(r.clients) >= r.hub.cfg.MaxParticipants {
		request.result <- "room_full"
		return
	}
	memberID := fmt.Sprintf("m%d", r.nextMember)
	r.nextMember++
	request.client.id = memberID
	request.client.member = room.Member{ID: memberID, Nickname: request.nickname, JoinedAt: time.Now()}

	ctx, cancel := context.WithTimeout(r.hub.ctx, storeTimeout)
	defer cancel()
	if err := r.hub.store.AddMember(ctx, r.id, request.client.member); err != nil {
		slog.ErrorContext(ctx, "add websocket member failed", "room_id", r.id, "member_id", memberID, "error", err)
		request.result <- "internal_error"
		return
	}
	state, err := r.hub.store.GetState(ctx, r.id)
	if err != nil {
		slog.ErrorContext(ctx, "load websocket state failed", "room_id", r.id, "error", err)
		_ = r.hub.store.RemoveMember(ctx, r.id, memberID)
		request.result <- "internal_error"
		return
	}
	if state.Rate == 0 {
		state.Rate = 1
	}
	history, err := r.hub.store.Messages(ctx, r.id)
	if err != nil {
		slog.ErrorContext(ctx, "load websocket chat failed", "room_id", r.id, "error", err)
		_ = r.hub.store.RemoveMember(ctx, r.id, memberID)
		request.result <- "internal_error"
		return
	}
	if r.controllerID == "" {
		if err := r.hub.store.SetController(ctx, r.id, memberID); err != nil {
			slog.ErrorContext(ctx, "set initial websocket controller failed", "room_id", r.id, "error", err)
			_ = r.hub.store.RemoveMember(ctx, r.id, memberID)
			request.result <- "internal_error"
			return
		}
		r.controllerID = memberID
	}
	r.clients[memberID] = request.client
	members := r.members()
	request.client.send <- Outbound{
		Type: "welcome", MemberID: memberID, State: &state, ControllerID: r.controllerID,
		Members: members, History: history, ServerTimeMs: time.Now().UnixMilli(),
	}
	request.client.send <- Outbound{
		Type: "pong", ServerTimeMs: time.Now().UnixMilli(), ClientTimeMs: request.clientTimeMs,
	}
	r.broadcastExcept(request.client, Outbound{
		Type: "members", ControllerID: r.controllerID, Members: members,
	})
	request.result <- ""
}

func (r *roomConn) handleDisconnect(disconnected *client) {
	if disconnected == nil || r.clients[disconnected.id] != disconnected {
		return
	}
	delete(r.clients, disconnected.id)
	close(disconnected.send)
	ctx, cancel := context.WithTimeout(r.hub.ctx, storeTimeout)
	defer cancel()
	if err := r.hub.store.RemoveMember(ctx, r.id, disconnected.id); err != nil {
		slog.ErrorContext(ctx, "remove websocket member failed", "room_id", r.id, "member_id", disconnected.id, "error", err)
	}
	if disconnected.id == r.controllerID {
		members := r.members()
		if len(members) == 0 {
			r.controllerID = ""
		} else {
			r.controllerID = members[0].ID
			if err := r.hub.store.SetController(ctx, r.id, r.controllerID); err != nil {
				slog.ErrorContext(ctx, "promote websocket controller failed", "room_id", r.id, "error", err)
			}
		}
	}
	if len(r.clients) > 0 {
		r.broadcast(Outbound{Type: "members", ControllerID: r.controllerID, Members: r.members()})
	}
}

func (r *roomConn) handleInbound(event clientInbound) {
	message := event.message
	switch message.Type {
	case "heartbeat":
		r.send(event.client, Outbound{
			Type: "pong", ServerTimeMs: time.Now().UnixMilli(), ClientTimeMs: message.ClientTimeMs,
		})
	case "chat":
		if !validChat(message.Text) {
			r.send(event.client, Outbound{Type: "error", ErrCode: "invalid_chat"})
			return
		}
		chat := room.ChatMessage{Author: event.client.member.Nickname, Text: message.Text, At: time.Now()}
		ctx, cancel := context.WithTimeout(r.hub.ctx, storeTimeout)
		err := r.hub.store.AddMessage(ctx, r.id, chat)
		cancel()
		if err != nil {
			slog.Error("persist websocket chat failed", "room_id", r.id, "error", err)
			r.send(event.client, Outbound{Type: "error", ErrCode: "internal_error"})
			return
		}
		r.broadcast(Outbound{Type: "chat", Message: &chat})
	case "delegate":
		r.handleDelegate(event.client, message)
	case "play", "pause", "seek", "rate":
		r.handleState(event.client, message)
	}
}

func (r *roomConn) handleDelegate(sender *client, message Inbound) {
	if sender.id != r.controllerID || r.clients[message.TargetID] == nil {
		return
	}
	ctx, cancel := context.WithTimeout(r.hub.ctx, storeTimeout)
	defer cancel()
	if err := r.hub.store.SetController(ctx, r.id, message.TargetID); err != nil {
		slog.ErrorContext(ctx, "delegate websocket controller failed", "room_id", r.id, "error", err)
		r.send(sender, Outbound{Type: "error", ErrCode: "internal_error"})
		return
	}
	r.controllerID = message.TargetID
	r.broadcast(Outbound{Type: "members", ControllerID: r.controllerID, Members: r.members()})
}

func (r *roomConn) handleState(sender *client, message Inbound) {
	if sender.id != r.controllerID || message.PositionMs < 0 {
		return
	}
	ctx, cancel := context.WithTimeout(r.hub.ctx, storeTimeout)
	defer cancel()
	state, err := r.hub.store.GetState(ctx, r.id)
	if err != nil {
		slog.ErrorContext(ctx, "load state for websocket command failed", "room_id", r.id, "error", err)
		r.send(sender, Outbound{Type: "error", ErrCode: "internal_error"})
		return
	}
	if state.Rate == 0 {
		state.Rate = 1
	}
	now := time.Now().UnixMilli()
	switch message.Type {
	case "play":
		state.Playing = true
		state.PositionMs = message.PositionMs
		if message.Rate != 0 {
			if !validRate(message.Rate) {
				return
			}
			state.Rate = message.Rate
		}
	case "pause":
		state.Playing = false
		state.PositionMs = message.PositionMs
		if message.Rate != 0 {
			if !validRate(message.Rate) {
				return
			}
			state.Rate = message.Rate
		}
	case "seek":
		state.PositionMs = message.PositionMs
	case "rate":
		if !validRate(message.Rate) {
			return
		}
		state.PositionMs = ExpectedPositionMs(state, now)
		state.Rate = message.Rate
	}
	state.ServerTimeMs = now
	if err := r.hub.store.SetState(ctx, r.id, state); err != nil {
		slog.ErrorContext(ctx, "persist websocket state failed", "room_id", r.id, "error", err)
		r.send(sender, Outbound{Type: "error", ErrCode: "internal_error"})
		return
	}
	stateCopy := state
	r.broadcast(Outbound{Type: "state", State: &stateCopy})
}

func (r *roomConn) members() []room.Member {
	members := make([]room.Member, 0, len(r.clients))
	for _, connected := range r.clients {
		members = append(members, connected.member)
	}
	slices.SortFunc(members, func(a, b room.Member) int {
		if a.JoinedAt.Before(b.JoinedAt) {
			return -1
		}
		if a.JoinedAt.After(b.JoinedAt) {
			return 1
		}
		return strings.Compare(a.ID, b.ID)
	})
	return members
}

func (r *roomConn) broadcast(event Outbound) {
	for _, connected := range r.clients {
		r.send(connected, event)
	}
}

func (r *roomConn) broadcastExcept(excluded *client, event Outbound) {
	for _, connected := range r.clients {
		if connected != excluded {
			r.send(connected, event)
		}
	}
}

func (r *roomConn) send(target *client, event Outbound) {
	select {
	case target.send <- event:
	default:
		slog.Warn("websocket client send buffer full", "room_id", r.id, "member_id", target.id)
	}
}

func (r *roomConn) cleanupIdle() {
	ctx, cancel := context.WithTimeout(r.hub.ctx, storeTimeout)
	defer cancel()
	fileErr := os.RemoveAll(filepath.Join(r.hub.cfg.DataDir, "rooms", r.id))
	storeErr := r.hub.store.Delete(ctx, r.id)
	if err := errors.Join(fileErr, storeErr); err != nil {
		slog.ErrorContext(ctx, "idle room cleanup failed", "room_id", r.id, "error", err)
	}
}

func writeHandshakeError(conn *websocket.Conn, code string) {
	_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
	_ = conn.WriteJSON(Outbound{Type: "error", ErrCode: code})
	_ = conn.WriteControl(websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.ClosePolicyViolation, code), time.Now().Add(writeWait))
}

func sameHostnameOrigin(request *http.Request) bool {
	origin := request.Header.Get("Origin")
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	requestHost := request.Host
	if colon := strings.LastIndexByte(requestHost, ':'); colon >= 0 {
		requestHost = strings.Trim(requestHost[:colon], "[]")
	}
	return strings.EqualFold(parsed.Hostname(), requestHost)
}

func validRoomID(id string) bool {
	return id != "." && !strings.ContainsAny(id, "*?[]") && filepath.IsLocal(id) && filepath.Base(id) == id
}

func validNickname(value string) bool {
	return validText(value, maxWSNicknameBytes, false)
}

func validChat(value string) bool {
	return validText(value, maxChatBytes, true)
}

func validText(value string, maxBytes int, allowNewline bool) bool {
	if value == "" || len(value) > maxBytes || !utf8.ValidString(value) || strings.TrimSpace(value) == "" {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) && !(allowNewline && (character == '\n' || character == '\t')) {
			return false
		}
	}
	return true
}

func validRate(rate float64) bool {
	return rate >= 0.25 && rate <= 4 && !math.IsNaN(rate) && !math.IsInf(rate, 0)
}

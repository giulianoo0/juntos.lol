package sync

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime/debug"
	"slices"
	"strings"
	stdsync "sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/objectstore"
	"github.com/giulianoo0/ss/internal/room"
)

const (
	maxWSMessageBytes    = 16 << 10
	maxWSNicknameBytes   = 64
	maxChatBytes         = 2 << 10
	storeTimeout         = 5 * time.Second
	maxTitleFieldBytes   = 256
	maxTitleURLBytes     = 1 << 10
	titleRequestCooldown = 5 * time.Second
)

type Hub struct {
	store         *room.Store
	bucket        room.MediaStore
	cfg           config.Config
	upgrader      websocket.Upgrader
	idleAfter     time.Duration
	gateTimeout   time.Duration
	stallCooldown time.Duration

	onReclaimed func(roomID string)

	onPosition func(roomID string, positionMs int64)

	mu           stdsync.Mutex
	rooms        map[string]*roomConn
	capabilities map[string]map[string]string
	closed       bool
	ctx          context.Context
	cancel       context.CancelFunc
	closeOnce    stdsync.Once
	wg           stdsync.WaitGroup
}

type roomConn struct {
	id               string
	hub              *Hub
	controllerID     string
	gating           bool
	ownerToken       string
	gate             *playGate
	ignored          map[string]struct{}
	stallGateReadyAt time.Time
	lastActivity     time.Time
	asked            bool
	playing          bool
	progressMu       stdsync.Mutex
	lastProgressAt   time.Time

	nextMember int
	clients    map[string]*client
	register   chan joinRequest
	unregister chan *client
	inbound    chan clientInbound
	updates    chan Outbound
}

type joinRequest struct {
	client       *client
	nickname     string
	clientTimeMs int64
	ownerToken   string
	result       chan string
}

type clientInbound struct {
	client  *client
	message Inbound
}

func (h *Hub) OnPosition(fn func(roomID string, positionMs int64)) {
	h.onPosition = fn
}

func NewHub(store *room.Store, cfg config.Config, bucket room.MediaStore) *Hub {
	if cfg.MaxParticipants < 1 {
		cfg.MaxParticipants = 1
	}
	if cfg.RoomIdleSeconds < 1 {
		cfg.RoomIdleSeconds = 1
	}
	ctx, cancel := context.WithCancel(context.Background())
	h := &Hub{
		store:         store,
		bucket:        bucket,
		cfg:           cfg,
		idleAfter:     time.Duration(cfg.RoomIdleSeconds) * time.Second,
		gateTimeout:   GateMaxWait,
		stallCooldown: stallRegateCooldown,
		rooms:         make(map[string]*roomConn),
		capabilities:  make(map[string]map[string]string),
		ctx:           ctx,
		cancel:        cancel,
		upgrader: websocket.Upgrader{
			CheckOrigin: sameHostnameOrigin,
		},
	}
	h.wg.Add(1)
	go h.sweepAbandonedLoop()
	return h
}

// OnRoomReclaimed registers what to do when a room is torn down for good, so
// the work it started elsewhere goes with it. Set once at startup.
func (h *Hub) OnRoomReclaimed(fn func(roomID string)) {
	h.onReclaimed = fn
}

// Live reports the rooms with someone in them and how many people that is.
// Counted from the capability table rather than each room's client map, which
// belongs to the room's own goroutine.
func (h *Hub) Live() (rooms, members int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, room := range h.capabilities {
		if len(room) == 0 {
			continue
		}
		rooms++
		members += len(room)
	}
	return rooms, members
}

// AuthorizeMember validates the short-lived in-memory capability issued by
// the WebSocket welcome message. It is never accepted from a URL or nickname.
func (h *Hub) AuthorizeMember(roomID, memberID, capability string) bool {
	h.mu.Lock()
	want := h.capabilities[roomID][memberID]
	h.mu.Unlock()
	return want != "" && len(want) == len(capability) && subtle.ConstantTimeCompare([]byte(want), []byte(capability)) == 1
}

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
	if hello.Type != "hello" || !validNickname(nickname) {
		writeHandshakeError(conn, "invalid_hello")
		return
	}

	roomConnection := h.getOrCreateRoom(roomID, storedRoom.ControllerID, storedRoom.OwnerToken, storedRoom.GatingEnabled)
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
		client: client, nickname: nickname, clientTimeMs: hello.ClientTimeMs,
		ownerToken: hello.OwnerToken, result: result,
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

func (h *Hub) NotifyStatus(roomID, status string) {
	h.notify(roomID, Outbound{Type: "roomStatus", Status: status})
}

// NotifyRoomUpdated tells clients to refresh room metadata without changing
// media readiness. Subtitle extraction uses this path.
func (h *Hub) NotifyRoomUpdated(roomID string) {
	h.notify(roomID, Outbound{Type: "roomUpdated"})
}

// NotifyRoomMedia is a roomUpdated that says what moved — regions, offset,
// version — so a viewer applies it in place instead of refetching the room.
func (h *Hub) NotifyRoomMedia(roomID string, media room.MediaSnapshot) {
	h.notify(roomID, Outbound{Type: "roomUpdated", Media: &media})
}

const progressNotifyEvery = 5 * time.Second

// NotifyRoomProgress says the preparo moved, and nothing else did. Unlike an
// update, it is worth dropping: the next one carries the same story.
func (h *Hub) NotifyRoomProgress(roomID string) {
	h.mu.Lock()
	connection := h.rooms[roomID]
	h.mu.Unlock()
	if connection == nil {
		return
	}
	now := time.Now()
	connection.progressMu.Lock()
	due := now.Sub(connection.lastProgressAt) >= progressNotifyEvery
	if due {
		connection.lastProgressAt = now
	}
	connection.progressMu.Unlock()
	if due {
		h.notify(roomID, Outbound{Type: "roomUpdated"})
	}
}

func (h *Hub) notify(roomID string, event Outbound) {
	h.mu.Lock()
	connection := h.rooms[roomID]
	h.mu.Unlock()
	if connection == nil {
		return
	}
	select {
	case connection.updates <- event:
	default:
	}
}

func (h *Hub) getOrCreateRoom(roomID, controllerID, ownerToken string, gating bool) *roomConn {
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
		ownerToken:   ownerToken,
		gating:       gating,
		nextMember:   1,
		clients:      make(map[string]*client),
		register:     make(chan joinRequest),
		unregister:   make(chan *client),
		inbound:      make(chan clientInbound),
		updates:      make(chan Outbound, 4),
	}
	h.rooms[roomID] = connection
	h.wg.Go(connection.run)
	return connection
}

func (h *Hub) removeRoom(roomID string, connection *roomConn) {
	h.mu.Lock()
	if h.rooms[roomID] == connection {
		delete(h.rooms, roomID)
		delete(h.capabilities, roomID)
	}
	h.mu.Unlock()
}

func (r *roomConn) run() {
	defer func() {
		if p := recover(); p != nil {
			slog.Error("room goroutine panicked", "room_id", r.id, "panic", p, "stack", string(debug.Stack()))
		}
	}()
	defer r.hub.removeRoom(r.id, r)
	defer r.dropGate()
	defer func() {
		for _, connected := range r.clients {
			close(connected.send)
		}
	}()
	var idleTimer *time.Timer
	var idle <-chan time.Time
	r.lastActivity = time.Now()
	awake := time.NewTicker(idleTick)
	defer awake.Stop()
	for {
		var gateExpired <-chan time.Time
		if r.gate != nil {
			gateExpired = r.gate.timer.C
		}
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
		case event := <-r.updates:
			r.broadcast(event)
		case <-gateExpired:
			r.releaseGate()
		case <-awake.C:
			if r.sweepIdle() {
				return
			}
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
	capabilityBytes := make([]byte, 32)
	if _, err := rand.Read(capabilityBytes); err != nil {
		request.result <- "internal_error"
		return
	}
	request.client.capability = base64.RawURLEncoding.EncodeToString(capabilityBytes)
	request.client.member = room.Member{ID: memberID, Nickname: request.nickname, JoinedAt: time.Now()}
	request.client.telemetry.joinedAt = time.Now()

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
	_, controllerLive := r.clients[r.controllerID]
	claimsOwnership := r.ownerToken != "" && request.ownerToken != "" &&
		subtle.ConstantTimeCompare([]byte(r.ownerToken), []byte(request.ownerToken)) == 1
	if r.controllerID == "" || !controllerLive || claimsOwnership {
		if err := r.hub.store.SetController(ctx, r.id, memberID); err != nil {
			slog.ErrorContext(ctx, "set initial websocket controller failed", "room_id", r.id, "error", err)
			_ = r.hub.store.RemoveMember(ctx, r.id, memberID)
			request.result <- "internal_error"
			return
		}
		r.controllerID = memberID
	}
	r.clients[memberID] = request.client
	r.hub.mu.Lock()
	if r.hub.capabilities[r.id] == nil {
		r.hub.capabilities[r.id] = make(map[string]string)
	}
	r.hub.capabilities[r.id][memberID] = request.client.capability
	r.hub.mu.Unlock()
	r.touch()
	members := r.members()
	gating := r.gating
	r.send(request.client, Outbound{
		Type: "welcome", MemberID: memberID, State: &state, ControllerID: r.controllerID,
		Members: members, History: history, ServerTimeMs: time.Now().UnixMilli(),
		Capability: request.client.capability, Gating: &gating,
	})
	r.send(request.client, Outbound{
		Type: "pong", ServerTimeMs: time.Now().UnixMilli(), ClientTimeMs: request.clientTimeMs,
	})
	r.broadcastExcept(request.client, Outbound{
		Type: "members", ControllerID: r.controllerID, Members: members,
	})
	r.broadcastWaiting()
	request.result <- ""
}

// handleSource records which browser holds the room's source. Only the one
// running the pipeline says so, and only the three origins the room knows
// are kept; everyone then refetches the room to learn it.
func (r *roomConn) handleSource(sender *client, message Inbound) {
	switch message.Origin {
	case "file", "torrent", "url":
	default:
		return
	}
	ctx, cancel := context.WithTimeout(r.hub.ctx, storeTimeout)
	err := r.hub.store.SetSourceHolder(ctx, r.id, sender.id, message.Origin)
	cancel()
	if err != nil {
		slog.ErrorContext(r.hub.ctx, "record source holder failed", "room_id", r.id, "error", err)
		return
	}
	r.broadcast(Outbound{Type: "roomUpdated"})
}

// handleMemberAction is the controller acting on one other member: handing
// them the controls, or putting them out of the room.
func (r *roomConn) handleMemberAction(sender *client, message Inbound) {
	if sender.id != r.controllerID {
		r.send(sender, Outbound{Type: "error", ErrCode: "not_controller"})
		return
	}
	target, ok := r.clients[message.TargetID]
	if !ok || target == sender {
		r.send(sender, Outbound{Type: "error", ErrCode: "member_not_found"})
		return
	}
	switch message.Type {
	case "transfer":
		ctx, cancel := context.WithTimeout(r.hub.ctx, storeTimeout)
		err := r.hub.store.SetController(ctx, r.id, target.id)
		cancel()
		if err != nil {
			slog.ErrorContext(r.hub.ctx, "transfer websocket controller failed", "room_id", r.id, "error", err)
			r.send(sender, Outbound{Type: "error", ErrCode: "internal_error"})
			return
		}
		r.controllerID = target.id
		r.broadcast(Outbound{Type: "members", ControllerID: r.controllerID, Members: r.members()})
	case "kick":
		r.send(target, Outbound{Type: "error", ErrCode: "kicked", closeAfter: true})
	}
	r.touch()
}

func (r *roomConn) handleDisconnect(disconnected *client) {
	if disconnected == nil || r.clients[disconnected.id] != disconnected {
		return
	}
	delete(r.clients, disconnected.id)
	r.logSyncSummary(disconnected)
	delete(r.ignored, disconnected.id)
	r.hub.mu.Lock()
	delete(r.hub.capabilities[r.id], disconnected.id)
	r.hub.mu.Unlock()
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
	if r.gate != nil {
		if len(r.clients) == 0 {
			r.dropGate()
		} else if !r.evaluateGate() {
			r.broadcastWaiting()
		}
	}
}

func (r *roomConn) handleInbound(event clientInbound) {
	message := event.message
	switch message.Type {
	case "heartbeat":
		r.send(event.client, Outbound{
			Type: "pong", ServerTimeMs: time.Now().UnixMilli(), ClientTimeMs: message.ClientTimeMs,
		})
	case "ready":
		if message.PositionMs < 0 || message.BufferAheadMs < 0 {
			return
		}
		event.client.report = memberReport{
			positionMs:    message.PositionMs,
			bufferAheadMs: message.BufferAheadMs,
			stalled:       message.Stalled,
			received:      true,
		}
		now := time.Now().UnixMilli()
		readyCtx, cancelReady := context.WithTimeout(r.hub.ctx, storeTimeout)
		defer cancelReady()
		r.recordSync(readyCtx, event.client, message, now)
		if r.gate != nil {
			if !r.evaluateGate() {
				r.broadcastWaiting()
			}
			return
		}
		r.gateOnStall(readyCtx, now)
	case "gating":
		r.handleGatingToggle(event.client, message)
	case "ignore":
		r.handleIgnore(event.client, message)
	case "kick", "transfer":
		r.handleMemberAction(event.client, message)
	case "source":
		r.handleSource(event.client, message)
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
		r.touch()
	case "play", "pause", "seek", "rate":
		r.handleState(event.client, message)
		r.touch()
	case "titleRequest":
		r.handleTitleRequest(event.client, message)
		r.touch()
	case "stillHere":
		r.touch()
	}
}

// handleTitleRequest relays a viewer's catalog pick to the whole room. The
// controller swaps sources directly, so its own requests are dropped, and a
// per-member cooldown keeps a viewer from flooding the room with asks.
func (r *roomConn) handleTitleRequest(sender *client, message Inbound) {
	request := message.Title
	if sender.id == r.controllerID || request == nil {
		return
	}
	if request.MetaID == "" || len(request.MetaID) > maxTitleFieldBytes ||
		(request.MetaType != "movie" && request.MetaType != "series") ||
		!validText(request.Name, maxTitleFieldBytes, false) ||
		len(request.Poster) > maxTitleURLBytes ||
		request.Season < 0 || request.Episode < 0 {
		return
	}
	now := time.Now()
	if now.Sub(sender.lastTitleRequest) < titleRequestCooldown {
		return
	}
	sender.lastTitleRequest = now
	relayed := *request
	relayed.From = sender.member.Nickname
	r.broadcast(Outbound{Type: "titleRequest", MemberID: sender.id, Title: &relayed})
}

func (r *roomConn) handleState(sender *client, message Inbound) {
	if sender.id != r.controllerID {
		r.send(sender, Outbound{Type: "error", ErrCode: "not_controller"})
		return
	}
	if message.PositionMs < 0 {
		return
	}
	if r.hub.onPosition != nil && message.Type != "rate" {
		go r.hub.onPosition(r.id, message.PositionMs)
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
		if message.Rate != 0 {
			if !validRate(message.Rate) {
				return
			}
			state.Rate = message.Rate
		}
		if r.shouldGate(ctx) {
			r.openGate(ctx, sender, message.PositionMs, state, now)
			return
		}
		state.Playing = true
		state.PositionMs = message.PositionMs
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
		if (state.Playing || r.gate != nil) && r.shouldGate(ctx) {
			r.openGate(ctx, sender, message.PositionMs, state, now)
			return
		}
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
	r.playing = state.Playing
	stateCopy := state
	r.broadcast(Outbound{Type: "state", State: &stateCopy})
	switch message.Type {
	case "play", "pause", "seek":
		r.dropGate()
	}
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
	if target == nil {
		return
	}
	select {
	case target.send <- event:
	default:
		slog.Warn("websocket client send buffer full", "room_id", r.id, "member_id", target.id)
	}
}

const preparingGrace = 10 * time.Minute

const (
	idleAsk   = 15 * time.Minute
	idleClose = 20 * time.Minute
	idleTick  = 15 * time.Second
)

// unfinishedWork names what an idle room still has running, or "" when
// reclaiming it destroys nothing. Status is not enough on its own: the room
// flips to ready while the source is still arriving.
func unfinishedWork(r *room.Room, now time.Time) string {
	if r.Status == "error" || r.ErrorMessage != "" {
		return ""
	}
	if now.Sub(r.CreatedAt) > preparingGrace {
		return ""
	}
	switch {
	case r.Status == "uploading" || r.Status == "processing":
		return "upload in progress"
	case r.Preparation.SourceBytes > 0 && r.Preparation.ReceivedBytes < r.Preparation.SourceBytes:
		return "source still arriving"
	}
	return ""
}

// touch records that the room did something on purpose, and takes back the
// question if one was outstanding.
func (r *roomConn) touch() {
	r.lastActivity = time.Now()
	if r.asked {
		r.asked = false
		r.broadcast(Outbound{Type: "awake"})
	}
}

// sweepIdle asks a quiet room whether anyone is still there, and closes it if
// the question went unanswered. It reports whether the room is gone. Only
// rooms with someone in them; an empty one belongs to the reclaim timer. A
// room that is playing is watching, not idle: the clock only runs while paused.
func (r *roomConn) sweepIdle() bool {
	if len(r.clients) == 0 {
		return false
	}
	if r.playing {
		r.touch()
		return false
	}
	quiet := time.Since(r.lastActivity)
	if quiet >= idleClose {
		r.cleanupIdle()
		return true
	}
	if quiet >= idleAsk && !r.asked {
		r.asked = true
		r.broadcast(Outbound{
			Type:         "stillThere",
			DeadlineMs:   r.lastActivity.Add(idleClose).UnixMilli(),
			ServerTimeMs: time.Now().UnixMilli(),
		})
	}
	return false
}

func (r *roomConn) cleanupIdle() {
	r.hub.reclaimIdle(r.id)
}

const abandonedSweepEvery = time.Minute

// sweepAbandoned reclaims every stored room that has no goroutine here and no
// work left to protect: the idle timer only fires once per goroutine.
func (h *Hub) sweepAbandoned() {
	ctx, cancel := context.WithTimeout(h.ctx, storeTimeout)
	ids, err := h.store.IDs(ctx)
	cancel()
	if err != nil {
		slog.ErrorContext(h.ctx, "list rooms for abandoned sweep failed", "error", err)
		return
	}
	for _, id := range ids {
		h.mu.Lock()
		_, live := h.rooms[id]
		h.mu.Unlock()
		if live {
			continue
		}
		h.reclaimIdle(id)
	}
}

func (h *Hub) sweepAbandonedLoop() {
	defer h.wg.Done()
	ticker := time.NewTicker(abandonedSweepEvery)
	defer ticker.Stop()
	for {
		select {
		case <-h.ctx.Done():
			return
		case <-ticker.C:
			h.sweepAbandoned()
		}
	}
}

// reclaimIdle tears down a room nobody is in, unless it still has work
// running. It reports whether the room is gone.
func (h *Hub) reclaimIdle(id string) bool {
	ctx, cancel := context.WithTimeout(h.ctx, storeTimeout)
	defer cancel()
	storedRoom, err := h.store.Get(ctx, id)
	if errors.Is(err, room.ErrNotFound) {
		return true
	}
	if err != nil {
		slog.ErrorContext(ctx, "load idle room before cleanup failed", "room_id", id, "error", err)
		return false
	}
	if reason := unfinishedWork(storedRoom, time.Now()); reason != "" {
		if err := h.store.SetController(ctx, id, ""); err != nil {
			slog.ErrorContext(ctx, "clear controller for idle active upload failed", "room_id", id, "error", err)
		}
		slog.InfoContext(ctx, "idle room kept", "room_id", id, "reason", reason)
		return false
	}
	fileErr := os.RemoveAll(filepath.Join(h.cfg.DataDir, "rooms", id))
	mediaCtx, cancelMedia := context.WithTimeout(h.ctx, 2*time.Minute)
	mediaErr := h.removeMedia(mediaCtx, id)
	cancelMedia()
	if mediaErr != nil {
		slog.ErrorContext(ctx, "idle room media cleanup failed", "room_id", id, "error", mediaErr)
		return false
	}
	storeErr := h.store.Delete(ctx, id)
	if err := errors.Join(fileErr, storeErr); err != nil {
		slog.ErrorContext(ctx, "idle room cleanup failed", "room_id", id, "error", err)
		return false
	}
	if h.onReclaimed != nil {
		h.onReclaimed(id)
	}
	slog.InfoContext(ctx, "idle room reclaimed",
		"room_id", id, "idle_for", h.idleAfter)
	return true
}

func (h *Hub) removeMedia(ctx context.Context, roomID string) error {
	if h.bucket == nil {
		return nil
	}
	return h.bucket.RemovePrefix(ctx, objectstore.RoomPrefix(roomID))
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

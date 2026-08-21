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
	"slices"
	"strings"
	stdsync "sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/metrics"
	"github.com/giulianoo0/ss/internal/objectstore"
	"github.com/giulianoo0/ss/internal/room"
)

const (
	maxWSMessageBytes  = 16 << 10
	maxWSNicknameBytes = 64
	maxChatBytes       = 2 << 10
	storeTimeout       = 5 * time.Second
)

type Hub struct {
	store *room.Store
	// bucket is where a reclaimed room's media is given back. The bucket's own
	// lifecycle rule is the backstop; this is what returns the storage as soon
	// as the room stops existing.
	bucket      room.MediaStore
	cfg         config.Config
	upgrader    websocket.Upgrader
	idleAfter   time.Duration
	gateTimeout time.Duration
	// stallCooldown is how long a room refuses to stop for a stall again after
	// releasing. A field so tests can exercise the stall path without waiting
	// out the real interval.
	stallCooldown time.Duration

	mu stdsync.Mutex
	// mediaWork is the pipeline asked whether a room still has an encode in
	// flight. Set once at startup; the queue that answers it cannot exist
	// before the hub, because its completion callbacks report back into one.
	mediaWork    MediaWork
	rooms        map[string]*roomConn
	capabilities map[string]map[string]string
	closed       bool
	ctx          context.Context
	cancel       context.CancelFunc
	closeOnce    stdsync.Once
	wg           stdsync.WaitGroup
}

type roomConn struct {
	id           string
	hub          *Hub
	controllerID string
	// gating mirrors the persisted room setting so the welcome frame does not
	// cost a store read. Only this connection's goroutine ever changes it.
	gating bool
	gate   *playGate
	// ignored holds members the controller has excused from synchronized
	// playback: the room neither waits for them nor stops when they stall.
	ignored map[string]struct{}
	// stallGateReadyAt is when the room may next stop for a stall, so one bad
	// connection cannot pause everyone in a loop.
	stallGateReadyAt time.Time
	nextMember       int
	clients          map[string]*client
	register         chan joinRequest
	unregister       chan *client
	inbound          chan clientInbound
	updates          chan Outbound
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

// NewHub creates a WebSocket hub backed by the room store and the bucket its
// media lives in.
// MediaWork reports whether a room still has pipeline work that reclaiming it
// would destroy — a queued or running remux.
type MediaWork interface {
	Busy(roomID string) bool
}

// SetMediaWork names the pipeline whose in-flight jobs keep an idle room
// alive. Called once during startup, before the hub serves anything.
func (h *Hub) SetMediaWork(work MediaWork) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.mediaWork = work
}

func (h *Hub) mediaBusy(roomID string) bool {
	h.mu.Lock()
	work := h.mediaWork
	h.mu.Unlock()
	return work != nil && work.Busy(roomID)
}

func NewHub(store *room.Store, cfg config.Config, bucket room.MediaStore) *Hub {
	if cfg.MaxParticipants < 1 {
		cfg.MaxParticipants = 1
	}
	if cfg.RoomIdleSeconds < 1 {
		cfg.RoomIdleSeconds = 1
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Hub{
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
}

// AuthorizeMember validates the short-lived in-memory capability issued by
// the WebSocket welcome message. It is never accepted from a URL or nickname.
func (h *Hub) AuthorizeMember(roomID, memberID, capability string) bool {
	h.mu.Lock()
	want := h.capabilities[roomID][memberID]
	h.mu.Unlock()
	return want != "" && len(want) == len(capability) && subtle.ConstantTimeCompare([]byte(want), []byte(capability)) == 1
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
	metrics.WebsocketConnections.Inc()
	defer metrics.WebsocketConnections.Dec()
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

	roomConnection := h.getOrCreateRoom(roomID, storedRoom.ControllerID, storedRoom.GatingEnabled)
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
	h.notify(roomID, Outbound{Type: "roomStatus", Status: status})
}

// NotifyRoomUpdated tells clients to refresh room metadata without changing
// media readiness. Subtitle extraction uses this path.
func (h *Hub) NotifyRoomUpdated(roomID string) {
	h.notify(roomID, Outbound{Type: "roomUpdated"})
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

func (h *Hub) getOrCreateRoom(roomID, controllerID string, gating bool) *roomConn {
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
	defer r.hub.removeRoom(r.id, r)
	defer r.dropGate()
	defer func() {
		// A shutdown closes the room out from under whoever is still in it,
		// so the gauge is settled here rather than left counting members of a
		// room that no longer exists.
		metrics.ParticipantsConnected.Sub(float64(len(r.clients)))
		for _, connected := range r.clients {
			close(connected.send)
		}
	}()
	var idleTimer *time.Timer
	var idle <-chan time.Time
	for {
		// A nil channel blocks forever, so the case only fires while gated.
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
		case <-idle:
			r.cleanupIdle()
			return
		}
	}
}

func (r *roomConn) handleJoin(request joinRequest) {
	if len(r.clients) >= r.hub.cfg.MaxParticipants {
		metrics.ParticipantJoins.WithLabelValues(metrics.JoinRejected).Inc()
		request.result <- "room_full"
		return
	}
	memberID := fmt.Sprintf("m%d", r.nextMember)
	r.nextMember++
	request.client.id = memberID
	capabilityBytes := make([]byte, 32)
	if _, err := rand.Read(capabilityBytes); err != nil {
		metrics.ParticipantJoins.WithLabelValues(metrics.JoinRejected).Inc()
		request.result <- "internal_error"
		return
	}
	request.client.capability = base64.RawURLEncoding.EncodeToString(capabilityBytes)
	request.client.member = room.Member{ID: memberID, Nickname: request.nickname, JoinedAt: time.Now()}

	ctx, cancel := context.WithTimeout(r.hub.ctx, storeTimeout)
	defer cancel()
	if err := r.hub.store.AddMember(ctx, r.id, request.client.member); err != nil {
		slog.ErrorContext(ctx, "add websocket member failed", "room_id", r.id, "member_id", memberID, "error", err)
		metrics.ParticipantJoins.WithLabelValues(metrics.JoinRejected).Inc()
		request.result <- "internal_error"
		return
	}
	state, err := r.hub.store.GetState(ctx, r.id)
	if err != nil {
		slog.ErrorContext(ctx, "load websocket state failed", "room_id", r.id, "error", err)
		_ = r.hub.store.RemoveMember(ctx, r.id, memberID)
		metrics.ParticipantJoins.WithLabelValues(metrics.JoinRejected).Inc()
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
		metrics.ParticipantJoins.WithLabelValues(metrics.JoinRejected).Inc()
		request.result <- "internal_error"
		return
	}
	if r.controllerID == "" {
		if err := r.hub.store.SetController(ctx, r.id, memberID); err != nil {
			slog.ErrorContext(ctx, "set initial websocket controller failed", "room_id", r.id, "error", err)
			_ = r.hub.store.RemoveMember(ctx, r.id, memberID)
			metrics.ParticipantJoins.WithLabelValues(metrics.JoinRejected).Inc()
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
	members := r.members()
	gating := r.gating
	// Through send rather than straight into the channel, so the frames a
	// join produces are counted like every other frame the room emits. The
	// buffer is untouched and 64 deep at this point, so nothing can be
	// dropped here that would not have blocked before.
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
	// A mid-wait joiner is counted in the quorum but never restarts the clock:
	// it only gets the pending roster so its client starts reporting.
	r.broadcastWaiting()
	metrics.ParticipantJoins.WithLabelValues(metrics.JoinAccepted).Inc()
	metrics.ParticipantsConnected.Inc()
	request.result <- ""
}

func (r *roomConn) handleDisconnect(disconnected *client) {
	if disconnected == nil || r.clients[disconnected.id] != disconnected {
		return
	}
	delete(r.clients, disconnected.id)
	metrics.ParticipantsConnected.Dec()
	metrics.ParticipantLeaves.Inc()
	// Being ignored is a decision about a person in this room right now. If
	// they come back — usually after fixing whatever was wrong — they rejoin
	// as a full member rather than silently still excluded.
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
	// A member who left must not keep the wait alive: everyone remaining may
	// now be the whole quorum.
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
	metrics.WebsocketMessages.WithLabelValues("in", inboundLabel(message.Type)).Inc()
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
		if r.gate != nil {
			if !r.evaluateGate() {
				r.broadcastWaiting()
			}
			return
		}
		// Nobody is waiting yet, so this report is the room's only chance to
		// notice that someone's playback has run dry mid-episode.
		stallCtx, cancelStall := context.WithTimeout(r.hub.ctx, storeTimeout)
		defer cancelStall()
		r.gateOnStall(stallCtx, time.Now().UnixMilli())
	case "gating":
		r.handleGatingToggle(event.client, message)
	case "ignore":
		r.handleIgnore(event.client, message)
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
	case "play", "pause", "seek", "rate":
		r.handleState(event.client, message)
	}
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
		// A seek that lands in playback is gated exactly like play, so it
		// puts everyone at the target together. A seek while a gate is
		// already pending retargets it rather than leaving a stale start.
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
	stateCopy := state
	r.broadcast(Outbound{Type: "state", State: &stateCopy})
	// An ungated play, pause or seek supersedes any start still pending;
	// leaving it would replay a stale target on timeout.
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
	// Outbound types are this package's own constants, so unlike the inbound
	// ones they need no clamping.
	metrics.WebsocketMessages.WithLabelValues("out", event.Type).Inc()
	select {
	case target.send <- event:
	default:
		slog.Warn("websocket client send buffer full", "room_id", r.id, "member_id", target.id)
	}
}

// unfinishedWork names what an idle room still has running, or "" when
// reclaiming it destroys nothing.
//
// Status is not enough on its own. The progressive preview publishes a
// playable segment seconds after the first megabyte and flips the room to
// ready there, which is the whole point of it — but the source goes on
// arriving for minutes after that, and the final ladder goes on encoding for
// longer still. Reclaiming on status alone deletes the room directory out from
// under a live ffmpeg, which dies renaming its output, and lands a finished
// upload in a room that no longer exists.
func unfinishedWork(r *room.Room, mediaBusy bool) string {
	switch {
	case r.Status == "uploading" || r.Status == "processing":
		return "upload in progress"
	case r.Preparation.SourceBytes > 0 && r.Preparation.ReceivedBytes < r.Preparation.SourceBytes:
		return "source still arriving"
	case mediaBusy:
		return "media pipeline running"
	}
	return ""
}

func (r *roomConn) cleanupIdle() {
	ctx, cancel := context.WithTimeout(r.hub.ctx, storeTimeout)
	defer cancel()
	storedRoom, err := r.hub.store.Get(ctx, r.id)
	if errors.Is(err, room.ErrNotFound) {
		return
	}
	if err != nil {
		slog.ErrorContext(ctx, "load idle room before cleanup failed", "room_id", r.id, "error", err)
		return
	}
	if reason := unfinishedWork(storedRoom, r.hub.mediaBusy(r.id)); reason != "" {
		// Work that outlives the websocket idle window keeps its persisted room
		// and files: tus can go on producing segments, and a running remux can
		// go on writing into a directory that still exists. A later connection
		// gets fresh ownership.
		if err := r.hub.store.SetController(ctx, r.id, ""); err != nil {
			slog.ErrorContext(ctx, "clear controller for idle active upload failed", "room_id", r.id, "error", err)
		}
		slog.InfoContext(ctx, "idle room kept", "room_id", r.id, "reason", reason)
		return
	}
	fileErr := os.RemoveAll(filepath.Join(r.hub.cfg.DataDir, "rooms", r.id))
	// The published media goes with the room. Nothing can reach it once the
	// room is gone — the playlists naming it are part of the room record — so
	// leaving it for the bucket's own rule only pays for storage nobody can
	// watch. Removed before the room record, which is the only thing that
	// still names these objects.
	mediaErr := r.hub.removeMedia(ctx, r.id)
	if mediaErr != nil {
		slog.ErrorContext(ctx, "idle room media cleanup failed", "room_id", r.id, "error", mediaErr)
		return
	}
	storeErr := r.hub.store.Delete(ctx, r.id)
	if err := errors.Join(fileErr, storeErr); err != nil {
		slog.ErrorContext(ctx, "idle room cleanup failed", "room_id", r.id, "error", err)
		return
	}
	// A room that everyone left is reclaimed well before its TTL, and used to
	// go without a word. Its link then answers room_not_found with nothing
	// anywhere saying why, which reads like data loss rather than the cleanup
	// it is.
	metrics.RoomsReclaimed.WithLabelValues(metrics.ReclaimIdle).Inc()
	slog.InfoContext(ctx, "idle room reclaimed",
		"room_id", r.id, "idle_for", r.hub.idleAfter)
}

// removeMedia gives a room's published objects back to the bucket.
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

// inboundLabel folds a client-supplied message type onto the closed set this
// package actually handles.
//
// The type arrives over the wire from a browser, and using it as a label value
// unchecked would let anyone mint an unbounded number of time series by
// sending nonsense — the metrics endpoint would grow until it, rather than the
// video, became the expensive part of the server.
func inboundLabel(messageType string) string {
	switch messageType {
	case "hello", "heartbeat", "ready", "gating", "ignore", "chat",
		"play", "pause", "seek", "rate":
		return messageType
	}
	return "other"
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

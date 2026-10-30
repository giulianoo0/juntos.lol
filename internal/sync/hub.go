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
	"sync/atomic"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/objectstore"
	"github.com/giulianoo0/ss/internal/room"
	"github.com/giulianoo0/ss/internal/usage"
)

const (
	maxWSMessageBytes    = 16 << 10
	maxWSNicknameBytes   = 64
	maxChatBytes         = 2 << 10
	maxTitleFieldBytes   = 256
	maxTitleURLBytes     = 1 << 10
	titleRequestCooldown = 5 * time.Second
)

// storeTimeout bounds one store call. A variable so tests can shrink it.
var storeTimeout = 5 * time.Second

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

	onThinLink func(roomID string) error

	onStageClose func(roomID, kind string)

	usage *usage.Counter

	mu           stdsync.Mutex
	rooms        map[string]*roomConn
	capabilities map[string]map[string]string
	grants       map[string]map[stageGrantKey]time.Time
	join         joinBook
	accounts     Accounts
	// presence counts, per signed-in account, its seats in each room.
	presence map[int64]map[string]int
	// devices is, per room, the seat each browser holds: a second tab of the
	// same browser takes that seat over instead of adding a person.
	devices   map[string]map[string]string
	closed    bool
	ctx       context.Context
	cancel    context.CancelFunc
	closeOnce stdsync.Once
	wg        stdsync.WaitGroup
}

type roomConn struct {
	id               string
	hub              *Hub
	controllerID     string
	gating           bool
	hostSubtitles    *HostSubtitles
	ownerToken       string
	gate             *playGate
	ignored          map[string]struct{}
	stallGateReadyAt time.Time
	lastActivity     time.Time
	asked            bool
	playing          bool
	progressMu       stdsync.Mutex
	lastProgressAt   time.Time
	// The newest position not yet handed to onPosition, and whether a
	// goroutine is handing them over: one at a time, newest last.
	positionMu      stdsync.Mutex
	pendingPosition *int64
	handingOver     bool
	// The media stage as last read, and the generation the host was asked to
	// put up for browsers, 0 when nothing is asked.
	media        roomMedia
	browserAsked int
	// A viewer's link already asked for a lighter rendition of this media,
	// or is asking now; a failed ask clears it from off the room's goroutine.
	thinAsked atomic.Bool

	nextMember    int
	nextRequest   int
	stageRequests []*stageRequest
	clients       map[string]*client
	// Seats whose socket dropped, kept for resumeGrace so the same member can
	// come back as themselves: same id, same capability, screen still up.
	detached map[string]*detachedSeat
	// Rung by a timer when a detached seat may have run out.
	expire     chan struct{}
	register   chan joinRequest
	unregister chan *client
	inbound    chan clientInbound
	updates    chan Outbound
	dropped    atomic.Bool
	// Closed when run returns: whoever would still hand the room something
	// gives up instead of waiting on a loop that is gone.
	done chan struct{}
}

type joinRequest struct {
	client       *client
	nickname     string
	clientTimeMs int64
	ownerToken   string
	// The seat a reconnecting socket asks to take back, or "" for a fresh join.
	memberID   string
	capability string
	device     string
	result     chan string
}

// detachedSeat is a member whose socket is gone but whose place is kept.
type detachedSeat struct {
	client *client
	until  time.Time
}

// resumeGrace is how long a dropped socket's seat is held for it. A variable
// so tests can shrink it.
var resumeGrace = 45 * time.Second

// leaveGrace holds the seat of a tab that said it was going, just long enough
// for a reload to take it back.
var leaveGrace = 10 * time.Second

type clientInbound struct {
	client  *client
	message Inbound
	// rateLimited stands in for a dropped message: the room tells the
	// sender, since only the room writes to its socket.
	rateLimited bool
}

// SetUsage wires the counting in. Set once at startup.
func (h *Hub) SetUsage(counter *usage.Counter) {
	h.usage = counter
}

func (h *Hub) OnPosition(fn func(roomID string, positionMs int64)) {
	h.onPosition = fn
}

// OnThinLink registers what to do the first time, per media, a viewer's
// link proves too thin for it: turning on a lighter rendition. An error asks
// again on the next thin reading. Set once at startup; it runs off the
// room's goroutine.
func (h *Hub) OnThinLink(fn func(roomID string) error) {
	h.onThinLink = fn
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
		grants:        make(map[string]map[stageGrantKey]time.Time),
		presence:      make(map[int64]map[string]int),
		devices:       make(map[string]map[string]string),
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

// deviceSeated reports whether the browser behind device already has a seat
// in the room, so another tab of it may come in without asking again.
func (h *Hub) deviceSeated(roomID, device string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	_, ok := h.devices[roomID][device]
	return ok
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
	_, data, err := conn.ReadMessage()
	if err != nil {
		return
	}
	if err := conn.SetReadDeadline(time.Time{}); err != nil {
		return
	}
	hello, ok := decodeHello(data)
	if !ok {
		writeHandshakeError(conn, "invalid_hello")
		return
	}
	identity := pickedAvatar(h.identify(c.Request), hello.Avatar)
	nickname := hello.Nickname
	if identity.AccountID != 0 && identity.Nickname != "" {
		nickname = identity.Nickname
	}

	roomConnection := h.getOrCreateRoom(storedRoom)
	if roomConnection == nil {
		writeHandshakeError(conn, "server_stopping")
		return
	}
	if errCode, sent := h.admit(conn, storedRoom, hello); errCode != "" || sent {
		if !sent {
			writeHandshakeError(conn, errCode)
		}
		return
	}
	client := &client{
		conn:        conn,
		room:        roomConnection,
		send:        make(chan Outbound, 64),
		telemetry:   syncTelemetry{device: deviceClass(c.Request.UserAgent())},
		identity:    identity,
		localSource: playsLocally(hello),
		localCopy:   copiesLocally(hello),
		kind:        clientKind(hello),
	}
	result := make(chan string, 1)
	request := joinRequest{
		client: client, nickname: nickname, clientTimeMs: hello.ClientTimeMs,
		ownerToken: hello.OwnerToken, memberID: hello.MemberID, capability: hello.Capability, device: hello.Device,
		result: result,
	}
	select {
	case roomConnection.register <- request:
	case <-roomConnection.done:
		// The room ended between the lookup and the join; the client's
		// reconnect finds out whether it is still there.
		return
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

// ResetPlayback puts the room back at zero and paused: the media behind it
// changed, so the clock every member was running means nothing for what
// comes next. Unlike a notification it is never dropped — a member who
// keeps the old clock waits at a position the new media may never reach.
func (h *Hub) ResetPlayback(roomID string) {
	state := room.PlayState{Rate: 1, ServerTimeMs: time.Now().UnixMilli()}
	ctx, cancel := context.WithTimeout(h.ctx, storeTimeout)
	defer cancel()
	if err := h.store.SetState(ctx, roomID, state); err != nil {
		slog.ErrorContext(ctx, "reset playback state failed", "room_id", roomID, "error", err)
	}
	h.mu.Lock()
	connection := h.rooms[roomID]
	h.mu.Unlock()
	if connection == nil {
		return
	}
	select {
	case connection.updates <- Outbound{Type: "state", State: &state, mediaChanged: true}:
	case <-ctx.Done():
	}
}

// NotifyRoomUpdated tells clients to refresh room metadata without changing
// media readiness. Subtitle extraction uses this path.
func (h *Hub) NotifyRoomUpdated(roomID string) {
	h.notify(roomID, Outbound{Type: "roomUpdated"})
	h.roomChanged(roomID)
}

// NotifyRoomMedia is a roomUpdated that says what moved — regions, offset,
// version — so a viewer applies it in place instead of refetching the room.
func (h *Hub) NotifyRoomMedia(roomID string, media room.MediaSnapshot) {
	h.notify(roomID, Outbound{Type: "roomUpdated", Media: &media})
	h.roomChanged(roomID)
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
		// A full queue must not lose the room's latest shape: the loop
		// re-announces it the next time it wakes up.
		connection.dropped.Store(true)
	}
}

func (h *Hub) getOrCreateRoom(stored *room.Room) *roomConn {
	roomID := stored.ID
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
		controllerID: stored.ControllerID,
		ownerToken:   stored.OwnerToken,
		gating:       stored.GatingEnabled,
		media:        mediaOf(stored),
		nextMember:   1,
		clients:      make(map[string]*client),
		detached:     make(map[string]*detachedSeat),
		expire:       make(chan struct{}, 1),
		register:     make(chan joinRequest),
		unregister:   make(chan *client),
		inbound:      make(chan clientInbound),
		updates:      make(chan Outbound, 32),
		done:         make(chan struct{}),
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
		delete(h.devices, roomID)
		delete(h.grants, roomID)
		for accountID, rooms := range h.presence {
			if delete(rooms, roomID); len(rooms) == 0 {
				delete(h.presence, accountID)
			}
		}
	}
	h.mu.Unlock()
}

func (r *roomConn) run() {
	defer close(r.done)
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
	// The idle clock starts when the last seat is really empty: a member whose
	// socket is being held for them still counts as here.
	armIdle := func() {
		if len(r.clients) > 0 || len(r.detached) > 0 || idle != nil {
			return
		}
		if idleTimer == nil {
			idleTimer = time.NewTimer(r.hub.idleAfter)
		} else {
			idleTimer.Reset(r.hub.idleAfter)
		}
		idle = idleTimer.C
	}
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
			armIdle()
		case <-r.expire:
			r.expireDetached(time.Now())
			armIdle()
		case event := <-r.inbound:
			r.handleInbound(event)
		case event := <-r.updates:
			if event.Type == "state" && event.State != nil {
				r.playing = event.State.Playing
				r.dropGate()
			}
			if event.mediaChanged {
				r.forgetLinks()
				ctx, cancel := context.WithTimeout(r.hub.ctx, storeTimeout)
				r.mediaChanged(ctx)
				cancel()
			}
			r.deliver(event)
			dropped := r.dropped.Swap(false)
			if dropped {
				r.broadcast(Outbound{Type: "roomUpdated"})
			}
			if dropped || event.Type == "roomStatus" || event.mediaChanged {
				ctx, cancel := context.WithTimeout(r.hub.ctx, storeTimeout)
				r.refreshMedia(ctx)
				cancel()
			}
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
	if request.memberID != "" && r.resume(request) {
		return
	}
	if previous := r.onDevice(request.device); previous != nil {
		if previous.member.AccountID == request.client.identity.AccountID {
			r.reseat(previous, request, true)
			return
		}
		r.dismiss(previous, Outbound{Type: "error", ErrCode: "replaced", closeAfter: true})
	}
	if len(r.clients)+len(r.detached) >= r.hub.cfg.MaxParticipants {
		request.result <- "room_full"
		return
	}
	memberID := fmt.Sprintf("m%d", r.nextMember)
	r.nextMember++
	request.client.id = memberID
	request.client.device = request.device
	capabilityBytes := make([]byte, 32)
	if _, err := rand.Read(capabilityBytes); err != nil {
		request.result <- "internal_error"
		return
	}
	request.client.capability = base64.RawURLEncoding.EncodeToString(capabilityBytes)
	request.client.member = withIdentity(room.Member{ID: memberID, Nickname: request.nickname, JoinedAt: time.Now(), Client: request.client.kind},
		request.client.identity)
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
		r.undoJoin(ctx, memberID)
		request.result <- "internal_error"
		return
	}
	if state.Rate == 0 {
		state.Rate = 1
	}
	history, err := r.hub.store.Messages(ctx, r.id)
	if err != nil {
		slog.ErrorContext(ctx, "load websocket chat failed", "room_id", r.id, "error", err)
		r.undoJoin(ctx, memberID)
		request.result <- "internal_error"
		return
	}
	_, controllerLive := r.clients[r.controllerID]
	if _, held := r.detached[r.controllerID]; held {
		controllerLive = true
	}
	claimsOwnership := r.ownerToken != "" && request.ownerToken != "" &&
		subtle.ConstantTimeCompare([]byte(r.ownerToken), []byte(request.ownerToken)) == 1
	if r.controllerID == "" || !controllerLive || claimsOwnership {
		if err := r.hub.store.SetController(ctx, r.id, memberID); err != nil {
			slog.ErrorContext(ctx, "set initial websocket controller failed", "room_id", r.id, "error", err)
			r.undoJoin(ctx, memberID)
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
	r.markDevice(request.client)
	r.arrived(ctx, request.client)
	r.countEntered(request.client)
	r.touch()
	members := r.members()
	gating := r.gating
	r.send(request.client, Outbound{
		Type: "welcome", MemberID: memberID, State: &state, ControllerID: r.controllerID,
		Members: members, History: history, ServerTimeMs: time.Now().UnixMilli(),
		Capability: request.client.capability, Gating: &gating, HostSubtitles: r.hostSubtitles,
	})
	r.send(request.client, Outbound{
		Type: "pong", ServerTimeMs: time.Now().UnixMilli(), ClientTimeMs: request.clientTimeMs,
	})
	r.broadcastExcept(request.client, Outbound{
		Type: "members", ControllerID: r.controllerID, Members: members,
	})
	r.broadcastWaiting()
	if r.controllerID == memberID {
		r.replayStageRequests()
	}
	r.syncBrowserMedia(request.client)
	r.joined(request.client, claimsOwnership)
	request.result <- ""
}

// undoJoin takes back the member a failed join already stored. If that fails
// too, the room lists a ghost until it ends, so it is logged.
func (r *roomConn) undoJoin(ctx context.Context, memberID string) {
	if err := r.hub.store.RemoveMember(ctx, r.id, memberID); err != nil {
		slog.ErrorContext(ctx, "undo websocket member failed", "room_id", r.id, "member_id", memberID, "error", err)
	}
}

// handleSource records which browser holds the room's source. Only the one
// running the pipeline says so — the member who opened the media, or the
// host whose reload made them a new member — and only the origins the room
// knows are kept; everyone then refetches the room to learn it.
func (r *roomConn) handleSource(sender *client, message Inbound) {
	switch message.Origin {
	case "file", "torrent", "url", "youtube":
	default:
		return
	}
	ctx, cancel := context.WithTimeout(r.hub.ctx, storeTimeout)
	stored, err := r.hub.store.Get(ctx, r.id)
	if err == nil && stored.SourceMemberID != sender.id && sender.id != r.controllerID {
		cancel()
		return
	}
	if err == nil {
		err = r.hub.store.SetSourceHolder(ctx, r.id, sender.id, message.Origin)
	}
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
	target := r.seat(message.TargetID)
	if target == nil || target == sender || message.Type == "transfer" && r.clients[target.id] != target {
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
		r.replayStageRequests()
		r.syncBrowserMedia(target)
	case "kick":
		r.dismiss(target, Outbound{Type: "error", ErrCode: "kicked", closeAfter: true})
	}
	r.touch()
}

// dismiss lets a member go at once, whether their socket is live or held;
// a live one hears farewell before it is closed.
func (r *roomConn) dismiss(target *client, farewell Outbound) {
	if r.clients[target.id] == target {
		r.send(target, farewell)
		delete(r.clients, target.id)
		close(target.send)
	} else {
		delete(r.detached, target.id)
	}
	r.finalizeLeave(target)
}

// handleDisconnect parks a member whose socket dropped: the seat, the
// capability and any screen they were sharing stay for resumeGrace, so a
// browser that reconnects a moment later is still the same person to
// everyone else. Nothing is announced until the grace runs out. A tab that
// said it was leaving gets only leaveGrace.
func (r *roomConn) handleDisconnect(disconnected *client) {
	if disconnected == nil || r.clients[disconnected.id] != disconnected {
		return
	}
	delete(r.clients, disconnected.id)
	close(disconnected.send)
	grace := resumeGrace
	if disconnected.leaving {
		grace = leaveGrace
	}
	until := time.Now().Add(grace)
	r.detached[disconnected.id] = &detachedSeat{client: disconnected, until: until}
	expire := r.expire
	time.AfterFunc(grace+10*time.Millisecond, func() {
		select {
		case expire <- struct{}{}:
		default:
		}
	})
	if r.gate != nil && !r.evaluateGate() {
		r.broadcastWaiting()
	}
}

// expireDetached lets go of every seat whose grace has passed.
func (r *roomConn) expireDetached(now time.Time) {
	for id, seat := range r.detached {
		if now.Before(seat.until) {
			continue
		}
		delete(r.detached, id)
		r.finalizeLeave(seat.client)
	}
}

// resume gives a reconnecting socket its old seat back, when the seat is
// held or still occupied by a socket the server has not noticed is dead. A
// mismatched capability is nobody's seat: the caller joins fresh.
func (r *roomConn) resume(request joinRequest) bool {
	previous := r.seat(request.memberID)
	if previous == nil || len(previous.capability) != len(request.capability) ||
		subtle.ConstantTimeCompare([]byte(previous.capability), []byte(request.capability)) != 1 {
		return false
	}
	r.reseat(previous, request, false)
	return true
}

// onDevice is the seat another tab of the same browser holds, if any.
func (r *roomConn) onDevice(device string) *client {
	if device == "" {
		return nil
	}
	for _, seat := range r.seats() {
		if seat.device == device {
			return seat
		}
	}
	return nil
}

func (r *roomConn) markDevice(member *client) {
	if member.device == "" {
		return
	}
	r.hub.mu.Lock()
	if r.hub.devices[r.id] == nil {
		r.hub.devices[r.id] = make(map[string]string)
	}
	r.hub.devices[r.id][member.device] = member.id
	r.hub.mu.Unlock()
}

// reseat hands a seat to a new socket. A socket still in it is told it was
// replaced, which only another tab acts on. A seat moved to another tab
// leaves behind what the old tab was sending: its screen, mic and camera.
func (r *roomConn) reseat(previous *client, request joinRequest, moved bool) {
	if r.clients[previous.id] == previous {
		// When its pump finally returns, the unregister finds a different
		// client in the seat and does nothing.
		r.send(previous, Outbound{Type: "error", ErrCode: "replaced", closeAfter: true})
		delete(r.clients, previous.id)
		close(previous.send)
	} else {
		delete(r.detached, previous.id)
	}
	next := request.client
	next.id = previous.id
	next.capability = previous.capability
	next.device = previous.device
	next.member = previous.member
	next.report = previous.report
	next.telemetry = previous.telemetry
	next.link = previous.link
	next.lastTitleRequest = previous.lastTitleRequest
	next.identity = previous.identity
	next.watch = previous.watch
	if moved {
		next.member.Mic, next.member.Cam = false, false
	}
	ctx, cancel := context.WithTimeout(r.hub.ctx, storeTimeout)
	defer cancel()
	renamed := false
	if request.nickname != next.member.Nickname || next.kind != next.member.Client {
		next.member.Nickname = request.nickname
		next.member.Client = next.kind
		if err := r.hub.store.AddMember(ctx, r.id, next.member); err != nil {
			slog.ErrorContext(ctx, "rename resumed websocket member failed", "room_id", r.id, "member_id", next.id, "error", err)
		}
		renamed = true
	}
	state, err := r.hub.store.GetState(ctx, r.id)
	if err != nil {
		slog.ErrorContext(ctx, "load websocket state failed", "room_id", r.id, "error", err)
		request.result <- "internal_error"
		return
	}
	if state.Rate == 0 {
		state.Rate = 1
	}
	history, err := r.hub.store.Messages(ctx, r.id)
	if err != nil {
		slog.ErrorContext(ctx, "load websocket chat failed", "room_id", r.id, "error", err)
		request.result <- "internal_error"
		return
	}
	if moved {
		stopped, err := r.hub.store.StopScreenShare(ctx, r.id, next.id)
		if err != nil {
			slog.ErrorContext(ctx, "stop moved member's screen share failed", "room_id", r.id, "member_id", next.id, "error", err)
		} else if stopped {
			r.broadcastExcept(next, Outbound{Type: "roomUpdated"})
		}
	}
	r.clients[next.id] = next
	r.touch()
	members := r.members()
	gating := r.gating
	r.send(next, Outbound{
		Type: "welcome", MemberID: next.id, State: &state, ControllerID: r.controllerID,
		Members: members, History: history, ServerTimeMs: time.Now().UnixMilli(),
		Capability: next.capability, Gating: &gating, HostSubtitles: r.hostSubtitles,
	})
	r.send(next, Outbound{
		Type: "pong", ServerTimeMs: time.Now().UnixMilli(), ClientTimeMs: request.clientTimeMs,
	})
	if renamed || moved {
		r.broadcastExcept(next, Outbound{Type: "members", ControllerID: r.controllerID, Members: members})
	}
	if r.gate != nil {
		r.broadcastWaiting()
	}
	r.syncBrowserMedia(next)
	request.result <- ""
}

// finalizeLeave is a member really going: the seat, the capability, the
// screen and, if they held it, the controls all pass on.
func (r *roomConn) finalizeLeave(disconnected *client) {
	defer r.hub.roomChanged(r.id)
	r.logSyncSummary(disconnected)
	r.countStay(disconnected)
	delete(r.ignored, disconnected.id)
	r.forgetStageRequests(disconnected.id)
	r.hub.mu.Lock()
	delete(r.hub.capabilities[r.id], disconnected.id)
	if r.hub.devices[r.id][disconnected.device] == disconnected.id {
		delete(r.hub.devices[r.id], disconnected.device)
	}
	r.hub.mu.Unlock()
	ctx, cancel := context.WithTimeout(r.hub.ctx, storeTimeout)
	defer cancel()
	if err := r.hub.store.RemoveMember(ctx, r.id, disconnected.id); err != nil {
		slog.ErrorContext(ctx, "remove websocket member failed", "room_id", r.id, "member_id", disconnected.id, "error", err)
	}
	r.left(ctx, disconnected)
	// Nothing else ends a screen share when a tab dies mid-broadcast, and a
	// share left in the list is a path every viewer keeps retrying forever.
	stopped, err := r.hub.store.StopScreenShare(ctx, r.id, disconnected.id)
	if err != nil {
		slog.ErrorContext(ctx, "stop screen share on disconnect failed", "room_id", r.id, "member_id", disconnected.id, "error", err)
	} else if stopped && len(r.clients) > 0 {
		r.broadcast(Outbound{Type: "roomUpdated"})
	}
	promoted := disconnected.id == r.controllerID
	if promoted {
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
		if promoted {
			r.replayStageRequests()
		}
	}
	var heir *client
	if promoted {
		heir = r.clients[r.controllerID]
	}
	r.syncBrowserMedia(heir)
	if r.gate != nil {
		if len(r.clients) == 0 {
			r.dropGate()
		} else if !r.evaluateGate() {
			r.broadcastWaiting()
		}
	}
}

func (r *roomConn) handleInbound(event clientInbound) {
	if event.rateLimited {
		r.send(event.client, Outbound{Type: "error", ErrCode: "rate_limited"})
		return
	}
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
		if !r.pauseAtProducedEdge(readyCtx, now) {
			r.gateOnStall(readyCtx, now)
		}
	case "gating":
		r.handleGatingToggle(event.client, message)
	case "subtitles":
		r.handleHostSubtitles(event.client, message)
	case "ignore":
		r.handleIgnore(event.client, message)
	case "kick", "transfer":
		r.handleMemberAction(event.client, message)
	case "source":
		r.handleSource(event.client, message)
	case "stageRequest":
		r.handleStageRequest(event.client, message)
	case "stageAnswer":
		r.handleStageAnswer(event.client, message)
	case "stageClose":
		r.handleStageClose(event.client, message)
	case "spotlight":
		r.handleSpotlight(event.client, message)
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
	case "leave":
		event.client.leaving = true
	case "media", "hostMute", "hostCamOff":
		r.handleCall(event.client, message)
	case "admit", "deny":
		r.handleAdmission(event.client, message)
	case "localCopyFailed":
		r.handleLocalCopyFailed(event.client, message)
	}
}

// handleHostSubtitles keeps the controller's subtitle pick for the room and
// tells everyone, so a viewer can copy it. It lives in memory only: the next
// host sends its own the moment it takes over.
func (r *roomConn) handleHostSubtitles(sender *client, message Inbound) {
	if sender.id != r.controllerID {
		r.send(sender, Outbound{Type: "error", ErrCode: "not_controller"})
		return
	}
	if message.Subtitles == nil || message.Subtitles.Track < -1 {
		return
	}
	prefs := *message.Subtitles
	r.hostSubtitles = &prefs
	r.broadcast(Outbound{Type: "hostSubtitles", HostSubtitles: &prefs})
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
	ctx, cancel := context.WithTimeout(r.hub.ctx, storeTimeout)
	defer cancel()
	if !r.mayDrive(ctx, sender) {
		r.send(sender, Outbound{Type: "error", ErrCode: "not_controller"})
		return
	}
	if message.PositionMs < 0 {
		return
	}
	if r.hub.onPosition != nil && message.Type != "rate" {
		r.handPosition(message.PositionMs)
	}
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

// handPosition passes a controller's position to onPosition off the room's
// goroutine, in order: while one is being handled the newest waits, and the
// ones it replaced are dropped, since only where the room is now matters.
func (r *roomConn) handPosition(positionMs int64) {
	r.positionMu.Lock()
	r.pendingPosition = &positionMs
	if r.handingOver {
		r.positionMu.Unlock()
		return
	}
	r.handingOver = true
	r.positionMu.Unlock()
	go func() {
		for {
			r.positionMu.Lock()
			next := r.pendingPosition
			r.pendingPosition = nil
			if next == nil {
				r.handingOver = false
				r.positionMu.Unlock()
				return
			}
			r.positionMu.Unlock()
			recovered("position handover", r.id, func() { r.hub.onPosition(r.id, *next) })
		}
	}()
}

// recovered runs fn, logging a panic instead of letting it take the whole
// server down: the hooks it guards run off the request that would recover it.
func recovered(what, roomID string, fn func()) {
	defer func() {
		if p := recover(); p != nil {
			slog.Error(what+" panicked", "room_id", roomID, "panic", p, "stack", string(debug.Stack()))
		}
	}()
	fn()
}

func (r *roomConn) members() []room.Member {
	members := make([]room.Member, 0, len(r.clients)+len(r.detached))
	for _, connected := range r.clients {
		members = append(members, connected.member)
	}
	for _, seat := range r.detached {
		members = append(members, seat.client.member)
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

// Variables so tests can shrink them.
var (
	idleAsk   = 15 * time.Minute
	idleClose = 20 * time.Minute
	idleTick  = 15 * time.Second
)

// unfinishedWork names what an idle room still has running, or "" when
// reclaiming it destroys nothing. Status is not enough on its own: the room
// flips to ready while the source is still arriving.
func unfinishedWork(r *room.Room, now time.Time) string {
	// A local source is the host's app, gone with everyone else: nothing
	// here keeps producing it.
	if r.Status == room.StatusError || r.ErrorMessage != "" || r.LocalSource {
		return ""
	}
	if now.Sub(r.CreatedAt) > preparingGrace {
		return ""
	}
	switch {
	case r.Status == room.StatusUploading || r.Status == room.StatusProcessing:
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
		if r.hub.reclaimIdle(r.id) {
			// Said before the sockets close, so a tab stops instead of
			// knocking on a room that is gone.
			r.broadcast(Outbound{Type: "error", ErrCode: "room_gone", closeAfter: true})
		}
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

// arrivalGrace is how long a new room waits for its host, who may still be
// picking a face at the door.
const arrivalGrace = 10 * time.Minute

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
		if live || h.awaitingHost(id) {
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

func (h *Hub) awaitingHost(id string) bool {
	ctx, cancel := context.WithTimeout(h.ctx, storeTimeout)
	defer cancel()
	stored, err := h.store.Get(ctx, id)
	return err == nil && time.Since(stored.CreatedAt) < arrivalGrace
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
	// The media can take longer than a store call: the delete gets its own clock.
	deleteCtx, cancelDelete := context.WithTimeout(h.ctx, storeTimeout)
	storeErr := h.store.Delete(deleteCtx, id)
	cancelDelete()
	if err := errors.Join(fileErr, storeErr); err != nil {
		slog.ErrorContext(ctx, "idle room cleanup failed", "room_id", id, "error", err)
		return false
	}
	if h.onReclaimed != nil {
		h.onReclaimed(id)
	}
	h.roomClosed(id)
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

package sync

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"strings"
	stdsync "sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/giulianoo0/ss/internal/room"
)

// ticketTTL is how long a password ticket stays good: long enough to open the
// socket right after typing the password. A variable so tests can expire one.
var ticketTTL = 2 * time.Minute

// lobbyWait is how long a guest knocks before the knock lapses; lobbyPing is
// how often the socket is checked for a guest who gave up.
const (
	lobbyWait = 10 * time.Minute
	lobbyPing = 15 * time.Second
)

// ActivityNotifier hears what a room is doing, for whatever mirrors it
// elsewhere (the Discord card). Calls must return at once.
type ActivityNotifier interface {
	// HostJoined is the owner taking their seat.
	HostJoined(roomID string)
	// RoomChanged is someone arriving or leaving, or the media changing.
	RoomChanged(roomID string)
	// RoomClosed is the room gone for good.
	RoomClosed(roomID string)
}

// joinBook is the hub's door: the key tickets are signed with, the knocks
// waiting on a host, and who to tell about the room's comings and goings.
type joinBook struct {
	once     stdsync.Once
	key      []byte
	mu       stdsync.Mutex
	knocks   map[string]map[string]*knock
	activity ActivityNotifier
}

type knock struct {
	nickname string
	decision chan bool
}

func (b *joinBook) init() {
	b.once.Do(func() {
		b.key = make([]byte, 32)
		if _, err := rand.Read(b.key); err != nil {
			panic("ticket key: " + err.Error())
		}
		b.knocks = make(map[string]map[string]*knock)
	})
}

// SetActivityNotifier wires what mirrors the rooms elsewhere. Set once at startup.
func (h *Hub) SetActivityNotifier(notifier ActivityNotifier) {
	h.join.init()
	h.join.mu.Lock()
	h.join.activity = notifier
	h.join.mu.Unlock()
}

func (h *Hub) activity() ActivityNotifier {
	h.join.init()
	h.join.mu.Lock()
	defer h.join.mu.Unlock()
	return h.join.activity
}

// MintTicket proves the password of one room was given: an HMAC over the
// room and an expiry, under a key that lives only in this process.
func (h *Hub) MintTicket(roomID string) string {
	h.join.init()
	payload := make([]byte, 8)
	binary.BigEndian.PutUint64(payload, uint64(time.Now().Add(ticketTTL).Unix()))
	return base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(h.ticketMAC(roomID, payload))
}

func (h *Hub) ticketMAC(roomID string, payload []byte) []byte {
	mac := hmac.New(sha256.New, h.join.key)
	mac.Write([]byte(roomID))
	mac.Write([]byte{'|'})
	mac.Write(payload)
	return mac.Sum(nil)
}

func (h *Hub) validTicket(roomID, ticket string) bool {
	h.join.init()
	encodedPayload, encodedMAC, ok := strings.Cut(ticket, ".")
	if !ok {
		return false
	}
	payload, err := base64.RawURLEncoding.DecodeString(encodedPayload)
	if err != nil || len(payload) != 8 {
		return false
	}
	mac, err := base64.RawURLEncoding.DecodeString(encodedMAC)
	if err != nil || !hmac.Equal(mac, h.ticketMAC(roomID, payload)) {
		return false
	}
	return time.Now().Unix() < int64(binary.BigEndian.Uint64(payload))
}

// admit decides whether a hello may take a seat. The host and a member
// taking back their own seat, from this tab or another, always may;
// otherwise the room's mode decides.
// An approval room parks the socket in the lobby until the host answers.
// It returns the handshake error to send, and whether one was already sent.
func (h *Hub) admit(conn *websocket.Conn, storedRoom *room.Room, hello Inbound) (string, bool) {
	if storedRoom.OwnerToken != "" && hello.OwnerToken != "" &&
		subtle.ConstantTimeCompare([]byte(storedRoom.OwnerToken), []byte(hello.OwnerToken)) == 1 {
		return "", false
	}
	if hello.MemberID != "" && h.AuthorizeMember(storedRoom.ID, hello.MemberID, hello.Capability) {
		return "", false
	}
	if hello.Device != "" && h.deviceSeated(storedRoom.ID, hello.Device) {
		return "", false
	}
	switch storedRoom.JoinMode {
	case room.JoinPassword:
		if hello.Ticket == "" {
			return "password_required", false
		}
		if !h.validTicket(storedRoom.ID, hello.Ticket) {
			return "bad_ticket", false
		}
	case room.JoinApproval:
		return h.waitInLobby(conn, storedRoom.ID, hello.Nickname)
	}
	return "", false
}

// waitInLobby knocks on the host's door and holds the socket until the host
// answers, the guest leaves, or the knock lapses.
func (h *Hub) waitInLobby(conn *websocket.Conn, roomID, nickname string) (string, bool) {
	h.join.init()
	requestID := newRequestID()
	pending := &knock{nickname: nickname, decision: make(chan bool, 1)}
	h.join.mu.Lock()
	if h.join.knocks[roomID] == nil {
		h.join.knocks[roomID] = make(map[string]*knock)
	}
	h.join.knocks[roomID][requestID] = pending
	h.join.mu.Unlock()
	defer func() {
		h.join.mu.Lock()
		delete(h.join.knocks[roomID], requestID)
		if len(h.join.knocks[roomID]) == 0 {
			delete(h.join.knocks, roomID)
		}
		h.join.mu.Unlock()
	}()

	_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
	if err := conn.WriteJSON(Outbound{Type: "lobby"}); err != nil {
		return "", true
	}
	h.notify(roomID, Outbound{Type: "knock", RequestID: requestID, Nickname: nickname, toController: true})

	// The socket is not read while it waits: a read that times out would
	// break it for good. A guest who went away shows up as a ping that
	// cannot be written.
	ping := time.NewTicker(lobbyPing)
	defer ping.Stop()
	timer := time.NewTimer(lobbyWait)
	defer timer.Stop()
	for {
		select {
		case allow := <-pending.decision:
			_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !allow {
				_ = conn.WriteJSON(Outbound{Type: "denied"})
				_ = conn.WriteControl(websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "denied"), time.Now().Add(writeWait))
				return "denied", true
			}
			if err := conn.WriteJSON(Outbound{Type: "admitted"}); err != nil {
				return "", true
			}
			return "", false
		case <-ping.C:
			if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeWait)); err != nil {
				return "", true
			}
		case <-timer.C:
			return "lobby_timeout", false
		case <-h.ctx.Done():
			return "server_stopping", false
		}
	}
}

// handleAdmission is the host answering a knock.
func (r *roomConn) handleAdmission(sender *client, message Inbound) {
	if sender.id != r.controllerID {
		r.send(sender, Outbound{Type: "error", ErrCode: "not_controller"})
		return
	}
	h := r.hub
	h.join.init()
	h.join.mu.Lock()
	pending := h.join.knocks[r.id][message.TargetID]
	if pending != nil {
		delete(h.join.knocks[r.id], message.TargetID)
	}
	h.join.mu.Unlock()
	if pending == nil {
		r.send(sender, Outbound{Type: "error", ErrCode: "request_not_found"})
		return
	}
	pending.decision <- message.Type == "admit"
}

// replayKnocks tells a host who just took their seat about everyone already waiting.
func (r *roomConn) replayKnocks(host *client) {
	h := r.hub
	h.join.init()
	h.join.mu.Lock()
	events := make([]Outbound, 0, len(h.join.knocks[r.id]))
	for requestID, pending := range h.join.knocks[r.id] {
		events = append(events, Outbound{Type: "knock", RequestID: requestID, Nickname: pending.nickname})
	}
	h.join.mu.Unlock()
	for _, event := range events {
		r.send(host, event)
	}
}

// joined runs once a new member has their seat: a host hears who is already
// knocking, and whatever mirrors the room hears about it.
func (r *roomConn) joined(member *client, owner bool) {
	if member.id == r.controllerID {
		r.replayKnocks(member)
	}
	if notifier := r.hub.activity(); notifier != nil {
		if owner {
			notifier.HostJoined(r.id)
		} else {
			notifier.RoomChanged(r.id)
		}
	}
}

func (h *Hub) roomChanged(roomID string) {
	if notifier := h.activity(); notifier != nil {
		notifier.RoomChanged(roomID)
	}
}

func (h *Hub) roomClosed(roomID string) {
	if notifier := h.activity(); notifier != nil {
		notifier.RoomClosed(roomID)
	}
}

// deliver hands an event from outside the loop to everyone, or only to the
// host when it is meant for the host alone.
func (r *roomConn) deliver(event Outbound) {
	if !event.toController {
		r.broadcast(event)
		return
	}
	r.send(r.clients[r.controllerID], event)
}

func newRequestID() string {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		panic("request id: " + err.Error())
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

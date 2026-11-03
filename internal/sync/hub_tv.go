package sync

import "context"

// tvMessages are all a TV may send: it keeps time with the room and may
// drive it by the same rules as anyone, but never puts anything on it.
var tvMessages = map[string]bool{
	"heartbeat": true, "ready": true, "stillHere": true, "leave": true,
	"play": true, "pause": true, "seek": true, "rate": true,
}

func (c *client) isTV() bool { return c.kind == ClientTV }

// tvHello holds a hello to what its sign-in says: a socket signed in with a
// TV's token is a TV whatever it claims, and nobody else may claim to be one.
func tvHello(hello Inbound, identity Identity) (Inbound, bool) {
	if !identity.TV {
		return hello, hello.Client != ClientTV
	}
	hello.Client = ClientTV
	hello.Features = nil
	hello.Device = ""
	hello.OwnerToken = ""
	return hello, true
}

// Seated reports whether the account holds a seat of its own in the room.
func (h *Hub) Seated(accountID int64, roomID string) bool { return h.accountSeated(accountID, roomID) }

// accountSeated reports whether the account holds a seat of its own in the room.
func (h *Hub) accountSeated(accountID int64, roomID string) bool {
	if accountID == 0 {
		return false
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.presence[accountID][roomID] > 0
}

// people counts the seats that are someone, connected or held.
func (r *roomConn) people() int {
	count := 0
	for _, seat := range r.seats() {
		if !seat.isTV() {
			count++
		}
	}
	return count
}

// connectedPeople counts the live sockets that are someone.
func (r *roomConn) connectedPeople() int {
	count := 0
	for _, connected := range r.clients {
		if !connected.isTV() {
			count++
		}
	}
	return count
}

// tvOwners is every account with a TV in the room.
func (r *roomConn) tvOwners() map[int64]bool {
	owners := make(map[int64]bool)
	for _, seat := range r.seats() {
		if seat.isTV() {
			owners[seat.identity.AccountID] = true
		}
	}
	return owners
}

// storeMember keeps the seat in the room's stored list. A TV is no one, so
// the list (the preview, the Discord card) never has it.
func (r *roomConn) storeMember(ctx context.Context, seat *client) error {
	if seat.isTV() {
		return nil
	}
	return r.hub.store.AddMember(ctx, r.id, seat.member)
}

package sync

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/giulianoo0/ss/internal/room"
)

// SetClientIP tells the hub how to read a request's real address, which a
// ban also matches on. Set once at startup; without it bans skip addresses.
func (h *Hub) SetClientIP(fn func(*http.Request) string) {
	h.clientIP = fn
}

func (h *Hub) requestIP(r *http.Request) string {
	if h.clientIP == nil {
		return ""
	}
	ip := h.clientIP(r)
	// Every local socket shares loopback: matching on it would put everyone out.
	if parsed := net.ParseIP(ip); parsed == nil || parsed.IsLoopback() || parsed.IsUnspecified() {
		return ""
	}
	return ip
}

// refuseBanned answers "kicked" to someone the host put out, before the
// password, the owner's token or the lobby are looked at: none of them lets
// a banned person past. A seat still in the room keeps reconnecting whatever
// address it comes from, so a housemate's ban never drops someone already in.
func (h *Hub) refuseBanned(ctx context.Context, roomID string, hello Inbound, identity Identity, ip string) string {
	bans, err := h.store.Bans(ctx, roomID)
	if err != nil {
		slog.ErrorContext(ctx, "load room bans failed", "room_id", roomID, "error", err)
		return "internal_error"
	}
	if len(bans) == 0 {
		return ""
	}
	arrival := room.Arrival{
		MemberID: hello.MemberID, Capability: hello.Capability, Device: hello.Device,
		AccountID: identity.AccountID, IP: ip,
	}
	if hello.MemberID != "" && h.AuthorizeMember(roomID, hello.MemberID, hello.Capability) {
		arrival.IP = ""
	}
	for _, ban := range bans {
		if ban.Matches(arrival) {
			return "kicked"
		}
	}
	return ""
}

// kick puts a member out and keeps them out: the ban is written before the
// socket is told, so a reconnect racing the farewell already meets it. Any
// other seat of the same account goes with them.
func (r *roomConn) kick(target *client) {
	ban := room.Ban{
		ID:         target.id,
		Nickname:   target.member.Nickname,
		Avatar:     target.member.Avatar,
		Capability: room.BanHash(target.capability),
		Device:     room.BanHash(target.device),
		AccountID:  target.identity.AccountID,
		IP:         room.BanHash(target.ip),
		At:         time.Now().UTC(),
	}
	ctx, cancel := context.WithTimeout(r.hub.ctx, storeTimeout)
	if err := r.hub.store.AddBan(ctx, r.id, ban); err != nil {
		slog.ErrorContext(ctx, "store room ban failed", "room_id", r.id, "member_id", target.id, "error", err)
	}
	cancel()
	farewell := Outbound{Type: "error", ErrCode: "kicked", closeAfter: true}
	r.dismiss(target, farewell)
	if ban.AccountID != 0 {
		for _, seat := range r.seats() {
			if seat.identity.AccountID == ban.AccountID && seat.id != r.controllerID {
				r.dismiss(seat, farewell)
			}
		}
	}
	r.broadcastBans()
}

// handleUnban is the host letting someone they put out come back.
func (r *roomConn) handleUnban(sender *client, message Inbound) {
	if sender.id != r.controllerID {
		r.send(sender, Outbound{Type: "error", ErrCode: "not_controller"})
		return
	}
	ctx, cancel := context.WithTimeout(r.hub.ctx, storeTimeout)
	removed, err := r.hub.store.RemoveBan(ctx, r.id, message.TargetID)
	cancel()
	if err != nil {
		slog.ErrorContext(r.hub.ctx, "remove room ban failed", "room_id", r.id, "error", err)
		r.send(sender, Outbound{Type: "error", ErrCode: "internal_error"})
		return
	}
	if !removed {
		r.send(sender, Outbound{Type: "error", ErrCode: "member_not_found"})
		return
	}
	r.broadcastBans()
	r.touch()
}

func (r *roomConn) banViews(ctx context.Context) []BanView {
	bans, err := r.hub.store.Bans(ctx, r.id)
	if err != nil {
		slog.ErrorContext(ctx, "load room bans failed", "room_id", r.id, "error", err)
		return nil
	}
	views := make([]BanView, 0, len(bans))
	for _, ban := range bans {
		views = append(views, BanView{ID: ban.ID, Nickname: ban.Nickname, Avatar: ban.Avatar})
	}
	return views
}

func (r *roomConn) broadcastBans() {
	if len(r.clients) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(r.hub.ctx, storeTimeout)
	defer cancel()
	r.broadcast(Outbound{Type: "bans", Bans: r.banViews(ctx)})
}

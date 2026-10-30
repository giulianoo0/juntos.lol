package httpapi

import (
	"errors"
	"net"
	"net/http"
	"net/netip"
	"strings"
	stdsync "sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
)

// TicketMinter cuts the proof a password was given; the hub checks it on hello.
type TicketMinter interface {
	MintTicket(roomID string) string
}

const (
	maxJoinBodyBytes = 1 << 10
	// joinAttemptsPerIP and joinAttemptsPerRoom bound password guessing: one
	// address gets a handful of tries at one room, and a room gets a few
	// dozen tries from everyone together, every joinAttemptWindow.
	joinAttemptsPerIP   = 10
	joinAttemptsPerRoom = 40
	joinAttemptWindow   = 10 * time.Minute
	previewNicknames    = 5
)

// RegisterJoinRoutes mounts the door of a room: what the entry screen may see
// before joining, trading the password for a ticket, and the host's switch
// for who gets in.
func RegisterJoinRoutes(rg *gin.RouterGroup, store *room.Store, cfg config.Config, tickets TicketMinter, authorizer memberAuthorizer, notify func(roomID string)) {
	perIP := newWindowLimiter(joinAttemptsPerIP, joinAttemptWindow)
	perRoom := newWindowLimiter(joinAttemptsPerRoom, joinAttemptWindow)
	rg.POST("/rooms/:id/join", joinRoom(store, tickets, perIP, perRoom, cfg.BehindCloudflare))
	rg.GET("/rooms/:id/preview", previewRoom(store))
	rg.PATCH("/rooms/:id/access", setRoomAccess(store, authorizer, notify))
}

func joinRoom(store *room.Store, tickets TicketMinter, perIP, perRoom *windowLimiter, behindEdge bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxJoinBodyBytes)
		var request struct {
			Password string `json:"password"`
		}
		if err := c.ShouldBindJSON(&request); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		roomID := c.Param("id")
		access, err := store.Access(c.Request.Context(), roomID)
		if errors.Is(err, room.ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "room_not_found"})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
			return
		}
		if access.Mode == room.JoinPassword {
			if !perIP.allow(roomID+"|"+requestIP(c.Request, behindEdge)) || !perRoom.allow(roomID) {
				c.JSON(http.StatusTooManyRequests, gin.H{"error": "too_many_attempts"})
				return
			}
			if !room.VerifyPassword(request.Password, access.PasswordHash) {
				c.JSON(http.StatusUnauthorized, gin.H{"error": "bad_password"})
				return
			}
		}
		c.JSON(http.StatusOK, gin.H{"ticket": tickets.MintTicket(roomID)})
	}
}

// previewRoom is what anyone with the link sees before joining: how the room
// is entered and who is there, and nothing about what it is playing.
func previewRoom(store *room.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		roomID := c.Param("id")
		storedRoom, err := store.Get(c.Request.Context(), roomID)
		if errors.Is(err, room.ErrNotFound) || err == nil && !storedRoom.ExpiresAt.After(time.Now()) {
			c.JSON(http.StatusNotFound, gin.H{"error": "room_not_found"})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
			return
		}
		members, err := store.Members(c.Request.Context(), roomID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
			return
		}
		nicknames := make([]string, 0, previewNicknames)
		for _, member := range members {
			if len(nicknames) == previewNicknames {
				break
			}
			nicknames = append(nicknames, member.Nickname)
		}
		c.JSON(http.StatusOK, gin.H{
			"name":        storedRoom.Name,
			"joinMode":    storedRoom.JoinMode,
			"memberCount": len(members),
			"nicknames":   nicknames,
		})
	}
}

// requestIP is the client address to rate-limit on. Behind the edge the
// server sees the edge, so the address the edge vouches for wins; directly,
// the socket's own, since anyone can write that header.
// requestIP is the client's address. Behind Cloudflare that is the edge's
// CF-Connecting-IP, but only on a request Cloudflare brought: the origin
// answers anyone who finds it, and they write the header themselves.
func requestIP(r *http.Request, behindEdge bool) string {
	if !behindEdge {
		return socketHost(r)
	}
	peer := strings.TrimSpace(r.Header.Get(proxyPeerHeader))
	if ip := strings.TrimSpace(r.Header.Get(clientIPHeader)); ip != "" && (peer == "" || fromCloudflare(peer)) {
		return ip
	}
	if peer != "" {
		return peer
	}
	return socketHost(r)
}

func socketHost(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// cloudflareRanges are the addresses Cloudflare connects to origins from,
// as published at https://www.cloudflare.com/ips/.
var cloudflareRanges = []netip.Prefix{
	netip.MustParsePrefix("173.245.48.0/20"),
	netip.MustParsePrefix("103.21.244.0/22"),
	netip.MustParsePrefix("103.22.200.0/22"),
	netip.MustParsePrefix("103.31.4.0/22"),
	netip.MustParsePrefix("141.101.64.0/18"),
	netip.MustParsePrefix("108.162.192.0/18"),
	netip.MustParsePrefix("190.93.240.0/20"),
	netip.MustParsePrefix("188.114.96.0/20"),
	netip.MustParsePrefix("197.234.240.0/22"),
	netip.MustParsePrefix("198.41.128.0/17"),
	netip.MustParsePrefix("162.158.0.0/15"),
	netip.MustParsePrefix("104.16.0.0/13"),
	netip.MustParsePrefix("104.24.0.0/14"),
	netip.MustParsePrefix("172.64.0.0/13"),
	netip.MustParsePrefix("131.0.72.0/22"),
	netip.MustParsePrefix("2400:cb00::/32"),
	netip.MustParsePrefix("2606:4700::/32"),
	netip.MustParsePrefix("2803:f800::/32"),
	netip.MustParsePrefix("2405:b500::/32"),
	netip.MustParsePrefix("2405:8100::/32"),
	netip.MustParsePrefix("2a06:98c0::/29"),
	netip.MustParsePrefix("2c0f:f248::/32"),
}

func fromCloudflare(peer string) bool {
	addr, err := netip.ParseAddr(peer)
	if err != nil {
		return false
	}
	addr = addr.Unmap()
	for _, prefix := range cloudflareRanges {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}

// windowLimiter allows `limit` hits per key in any sliding `window`.
type windowLimiter struct {
	mu     stdsync.Mutex
	limit  int
	window time.Duration
	hits   map[string][]time.Time
	swept  time.Time
}

func newWindowLimiter(limit int, window time.Duration) *windowLimiter {
	return &windowLimiter{limit: limit, window: window, hits: make(map[string][]time.Time)}
}

func (l *windowLimiter) allow(key string) bool {
	now := time.Now()
	cutoff := now.Add(-l.window)
	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Sub(l.swept) > l.window {
		for k, times := range l.hits {
			if len(times) == 0 || times[len(times)-1].Before(cutoff) {
				delete(l.hits, k)
			}
		}
		l.swept = now
	}
	recent := l.hits[key][:0]
	for _, at := range l.hits[key] {
		if at.After(cutoff) {
			recent = append(recent, at)
		}
	}
	if len(recent) >= l.limit {
		l.hits[key] = recent
		return false
	}
	l.hits[key] = append(recent, now)
	return true
}

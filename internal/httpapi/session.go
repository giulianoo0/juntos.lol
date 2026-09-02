package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
)

const (
	sessionCookie     = "ss_sid"
	sessionContextKey = "ss.session"
	sessionIDBytes    = 32
	// clientIPHeader is set by the edge proxy from the connection, so clients cannot spoof it.
	clientIPHeader = "CF-Connecting-IP"
)

// Sessions mints and recognises the anonymous identity the torrent routes require;
// rooms themselves stay open. The cookie is trivially reset, so minting is itself
// capped per client address.
type Sessions struct {
	rdb          *redis.Client
	ttl          time.Duration
	perIPPerHour int
	behindEdge   bool
}

// NewSessions returns a session minter. perIPPerHour caps how many fresh
// sessions one client address may create; 0 disables the cap.
func NewSessions(rdb *redis.Client, ttl time.Duration, perIPPerHour int, behindEdge bool) *Sessions {
	return &Sessions{rdb: rdb, ttl: ttl, perIPPerHour: perIPPerHour, behindEdge: behindEdge}
}

func sessionKey(id string) string { return "sess:" + id }
func ipSessionsKey(ip string) string {
	return "sessions:ip:" + ip + ":" + time.Now().UTC().Format("2006010215")
}

var ErrTooManySessions = errors.New("too many sessions")

// clientIP is the address to rate-limit on, or "" when there is no trustworthy one.
func (s *Sessions) clientIP(r *http.Request) string {
	if s.behindEdge {
		if ip := strings.TrimSpace(r.Header.Get(clientIPHeader)); ip != "" {
			return ip
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if !s.behindEdge {
		if parsed := net.ParseIP(host); parsed != nil && parsed.IsLoopback() {
			return ""
		}
	}
	return host
}

// secureRequest reports TLS here or at the edge, which is when the cookie may be Secure.
func secureRequest(r *http.Request) bool {
	return r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

// Lookup answers whether a session id is live, refreshing its expiry.
func (s *Sessions) Lookup(ctx context.Context, id string) (bool, error) {
	if len(id) != sessionIDBytes*2 {
		return false, nil
	}
	ok, err := s.rdb.Expire(ctx, sessionKey(id), s.ttl).Result()
	if err != nil {
		return false, err
	}
	return ok, nil
}

func (s *Sessions) Mint(ctx context.Context, ip string) (string, error) {
	if s.perIPPerHour > 0 && ip != "" {
		key := ipSessionsKey(ip)
		n, err := s.rdb.Incr(ctx, key).Result()
		if err != nil {
			return "", err
		}
		if n == 1 {
			s.rdb.Expire(ctx, key, time.Hour)
		}
		if n > int64(s.perIPPerHour) {
			return "", ErrTooManySessions
		}
	}
	raw := make([]byte, sessionIDBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	id := hex.EncodeToString(raw)
	if err := s.rdb.Set(ctx, sessionKey(id), time.Now().UTC().Format(time.RFC3339), s.ttl).Err(); err != nil {
		return "", err
	}
	return id, nil
}

// Middleware makes sure the request carries a live session, minting one
// when it does not, and leaves the id in the context for the handlers.
func (s *Sessions) Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		ctx := c.Request.Context()
		if cookie, err := c.Cookie(sessionCookie); err == nil {
			ok, err := s.Lookup(ctx, cookie)
			if err != nil {
				slog.ErrorContext(ctx, "session lookup", "error", err)
				c.AbortWithStatus(http.StatusInternalServerError)
				return
			}
			if ok {
				c.Set(sessionContextKey, cookie)
				c.Next()
				return
			}
		}
		id, err := s.Mint(ctx, s.clientIP(c.Request))
		if errors.Is(err, ErrTooManySessions) {
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": "too_many_sessions"})
			return
		}
		if err != nil {
			slog.ErrorContext(ctx, "session mint", "error", err)
			c.AbortWithStatus(http.StatusInternalServerError)
			return
		}
		http.SetCookie(c.Writer, &http.Cookie{
			Name:     sessionCookie,
			Value:    id,
			Path:     "/",
			MaxAge:   int(s.ttl / time.Second),
			HttpOnly: true,
			Secure:   secureRequest(c.Request),
			SameSite: http.SameSiteLaxMode,
		})
		c.Set(sessionContextKey, id)
		c.Next()
	}
}

func SessionID(c *gin.Context) string {
	id, _ := c.Get(sessionContextKey)
	s, _ := id.(string)
	return s
}

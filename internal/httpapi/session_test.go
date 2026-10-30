package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

func newSessionRig(t *testing.T, perIP int) (*gin.Engine, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })
	sessions := NewSessions(rdb, 24*time.Hour, perIP, true)
	r := gin.New()
	r.GET("/t", sessions.Middleware(), func(c *gin.Context) {
		c.String(http.StatusOK, SessionID(c))
	})
	return r, mr
}

func TestSessionMintedOnFirstSightAndRecognisedAfter(t *testing.T) {
	r, mr := newSessionRig(t, 0)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/t", nil))
	require.Equal(t, http.StatusOK, w.Code)
	cookies := w.Result().Cookies()
	require.Len(t, cookies, 1)
	c := cookies[0]
	require.Equal(t, sessionCookie, c.Name)
	require.True(t, c.HttpOnly)
	require.False(t, c.Secure, "plain http in tests: Secure follows the request")
	require.Equal(t, http.SameSiteLaxMode, c.SameSite)
	require.Equal(t, c.Value, w.Body.String())
	require.True(t, mr.Exists("sess:"+c.Value))

	w = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/t", nil)
	req.AddCookie(c)
	r.ServeHTTP(w, req)
	require.Equal(t, c.Value, w.Body.String())
	require.Empty(t, w.Result().Cookies())
}

func TestUnknownCookieIsReplaced(t *testing.T) {
	r, _ := newSessionRig(t, 0)
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/t", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookie, Value: "deadbeef"})
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
	require.Len(t, w.Result().Cookies(), 1)
	require.NotEqual(t, "deadbeef", w.Body.String())
}

func TestSecureCookieBehindTLSEdge(t *testing.T) {
	r, _ := newSessionRig(t, 0)
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/t", nil)
	req.Header.Set("X-Forwarded-Proto", "https")
	r.ServeHTTP(w, req)
	require.True(t, w.Result().Cookies()[0].Secure)
}

func TestNoEdgeHeaderIsIgnoredAndLoopbackIsUncapped(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })
	sessions := NewSessions(rdb, time.Hour, 1, false)
	r := gin.New()
	r.GET("/t", sessions.Middleware(), func(c *gin.Context) { c.Status(http.StatusOK) })
	for i := 0; i < 3; i++ {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/t", nil)
		req.RemoteAddr = "127.0.0.1:1234"
		req.Header.Set(clientIPHeader, "203.0.113."+string(rune('1'+i)))
		r.ServeHTTP(w, req)
		require.Equal(t, http.StatusOK, w.Code)
	}
}

func TestSessionMintingIsCappedPerClientAddress(t *testing.T) {
	r, _ := newSessionRig(t, 2)
	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/t", nil)
		req.Header.Set(clientIPHeader, "203.0.113.7")
		r.ServeHTTP(w, req)
		require.Equal(t, http.StatusOK, w.Code)
	}
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/t", nil)
	req.Header.Set(clientIPHeader, "203.0.113.7")
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusTooManyRequests, w.Code)
	require.Contains(t, w.Body.String(), "too_many_sessions")

	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/t", nil)
	req.Header.Set(clientIPHeader, "203.0.113.8")
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
}

// Someone who reaches the origin around Cloudflare writes whatever
// CF-Connecting-IP they like; the proxy's X-Real-IP says who they are.
func TestSessionMintingIsCappedPerPeerWhenTheEdgeHeaderIsForged(t *testing.T) {
	r, _ := newSessionRig(t, 2)
	codes := make([]int, 0, 3)
	for i := 0; i < 3; i++ {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/t", nil)
		req.Header.Set(proxyPeerHeader, "198.51.100.20")
		req.Header.Set(clientIPHeader, "203.0.113."+string(rune('1'+i)))
		r.ServeHTTP(w, req)
		codes = append(codes, w.Code)
	}
	require.Equal(t, []int{http.StatusOK, http.StatusOK, http.StatusTooManyRequests}, codes)
}

func TestClientAddress(t *testing.T) {
	tests := []struct {
		name       string
		behindEdge bool
		peer       string
		edge       string
		want       string
	}{
		{"the edge's word when Cloudflare brought the request", true, "172.64.80.1", "203.0.113.7", "203.0.113.7"},
		{"the edge's word from a Cloudflare IPv6 hop", true, "2606:4700::1", "203.0.113.7", "203.0.113.7"},
		{"the peer when the request went around Cloudflare", true, "198.51.100.20", "203.0.113.7", "198.51.100.20"},
		{"the edge's word without a proxy in front", true, "", "203.0.113.7", "203.0.113.7"},
		{"the socket when no edge is trusted", false, "198.51.100.20", "203.0.113.7", "192.0.2.1"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			if tt.peer != "" {
				req.Header.Set(proxyPeerHeader, tt.peer)
			}
			if tt.edge != "" {
				req.Header.Set(clientIPHeader, tt.edge)
			}
			require.Equal(t, tt.want, requestIP(req, tt.behindEdge))
		})
	}
}

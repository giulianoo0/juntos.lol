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
	require.True(t, c.Secure)
	require.Equal(t, http.SameSiteLaxMode, c.SameSite)
	require.Equal(t, c.Value, w.Body.String())
	require.True(t, mr.Exists("sess:"+c.Value))

	// Presenting the cookie: same id, no new cookie.
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

	// Another address is unaffected.
	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/t", nil)
	req.Header.Set(clientIPHeader, "203.0.113.8")
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
}

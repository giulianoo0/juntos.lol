package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/config"
)

func humanServer(t *testing.T, result siteverifyResult) (*gin.Engine, *HumanGate) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	gate := NewHumanGate(config.Config{TurnstileSiteKey: "site", TurnstileSecret: "s3cret", TurnstileHostnames: []string{"juntos.lol"}})
	gate.verify = func(_ context.Context, secret, token, _ string) (siteverifyResult, error) {
		if secret != "s3cret" || token != "good" {
			return siteverifyResult{}, nil
		}
		return result, nil
	}
	router := gin.New()
	router.POST("/api/human", gate.Verify)
	router.POST("/api/rooms", gate.Require(), func(c *gin.Context) { c.Status(http.StatusCreated) })
	return router, gate
}

func postHuman(router http.Handler, token string) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/human", strings.NewReader(`{"token":"`+token+`"}`))
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(recorder, request)
	return recorder
}

func createWith(router http.Handler, cookies ...*http.Cookie) int {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/rooms", nil)
	for _, cookie := range cookies {
		request.AddCookie(cookie)
	}
	router.ServeHTTP(recorder, request)
	return recorder.Code
}

func TestHumanGateLetsInWhoSolvedTurnstile(t *testing.T) {
	router, _ := humanServer(t, siteverifyResult{Success: true, Action: "human", Hostname: "juntos.lol"})
	require.Equal(t, http.StatusForbidden, createWith(router), "sem passar pelo Turnstile não abre sala")

	solved := postHuman(router, "good")
	require.Equal(t, http.StatusOK, solved.Code)
	cookies := solved.Result().Cookies()
	require.Len(t, cookies, 1)
	require.True(t, cookies[0].HttpOnly)
	require.Equal(t, http.StatusCreated, createWith(router, cookies[0]))
}

func TestHumanGateRefusesATokenForAnotherActionOrHost(t *testing.T) {
	for _, result := range []siteverifyResult{
		{Success: false, Action: "human", Hostname: "juntos.lol"},
		{Success: true, Action: "login", Hostname: "juntos.lol"},
		{Success: true, Action: "human", Hostname: "localhost"},
	} {
		router, _ := humanServer(t, result)
		recorder := postHuman(router, "good")
		require.Equal(t, http.StatusForbidden, recorder.Code, "%+v", result)
		require.Empty(t, recorder.Result().Cookies())
	}
}

func TestHumanGateRefusesAForgedOrExpiredCookie(t *testing.T) {
	router, gate := humanServer(t, siteverifyResult{Success: true, Action: "human", Hostname: "juntos.lol"})
	valid := gate.sign(time.Now().Add(time.Hour))
	stamp, _, _ := strings.Cut(valid, ".")
	require.Equal(t, http.StatusForbidden, createWith(router, &http.Cookie{Name: humanCookie, Value: stamp + ".forjado"}))
	require.Equal(t, http.StatusForbidden, createWith(router, &http.Cookie{Name: humanCookie, Value: gate.sign(time.Now().Add(-time.Minute))}))
	require.Equal(t, http.StatusCreated, createWith(router, &http.Cookie{Name: humanCookie, Value: valid}))
}

func TestNoTurnstileSecretAsksNobody(t *testing.T) {
	require.Nil(t, NewHumanGate(config.Config{}))
	router := gin.New()
	var gate *HumanGate
	router.POST("/api/rooms", gate.Require(), func(c *gin.Context) { c.Status(http.StatusCreated) })
	require.Equal(t, http.StatusCreated, createWith(router))
}

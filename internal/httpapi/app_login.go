package httpapi

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"html/template"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// The phone app signs in through the person's own browser, where Discord
// already knows them, and gets its own session back through a one-time code.
// The code is worth nothing without the verifier whose hash the app named at
// the start, so a code another app catches on the way back cannot be spent.
const (
	appHandoffTTL = 2 * time.Minute
	// AppLoginDonePath is where the browser lands with the code; the app
	// claims it as an App Link, and the page sends anyone still here back to it.
	AppLoginDonePath = "/api/auth/app/done"
)

var appChallenge = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

type appHandoff struct {
	session   string
	challenge string
	expires   time.Time
}

type appHandoffs struct {
	mu    sync.Mutex
	codes map[string]appHandoff
	now   func() time.Time
}

func newAppHandoffs() *appHandoffs {
	return &appHandoffs{codes: map[string]appHandoff{}, now: time.Now}
}

func (h *appHandoffs) put(code string, handoff appHandoff) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for key, old := range h.codes {
		if h.now().After(old.expires) {
			delete(h.codes, key)
		}
	}
	h.codes[code] = handoff
}

// take spends the code: it answers once, and only before it expires.
func (h *appHandoffs) take(code string) (appHandoff, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	handoff, ok := h.codes[code]
	delete(h.codes, code)
	if !ok || h.now().After(handoff.expires) {
		return appHandoff{}, false
	}
	return handoff, true
}

// startAppLogin sends the browser through Discord when it has no account yet,
// then mints the app a session of its own and hands it over by code.
func (a *accountRoutes) startAppLogin(c *gin.Context) {
	if a.login == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "accounts_disabled"})
		return
	}
	challenge := c.Query("challenge")
	if !appChallenge.MatchString(challenge) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad_challenge"})
		return
	}
	me, ok := a.viewer(c, false)
	if !ok {
		back := "/api/auth/app?challenge=" + url.QueryEscape(challenge)
		c.Redirect(http.StatusFound, "/api/auth/discord?next="+url.QueryEscape(back))
		return
	}
	ctx := c.Request.Context()
	session, err := a.accounts.StartSession(ctx, me.ID)
	if err != nil {
		slog.ErrorContext(ctx, "start app session", "error", err)
		c.Status(http.StatusInternalServerError)
		return
	}
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		c.Status(http.StatusInternalServerError)
		return
	}
	code := base64.RawURLEncoding.EncodeToString(raw)
	a.handoffs.put(code, appHandoff{session: session, challenge: challenge, expires: a.handoffs.now().Add(appHandoffTTL)})
	c.Header("Cache-Control", "no-store")
	c.Redirect(http.StatusFound, AppLoginDonePath+"?code="+url.QueryEscape(code))
}

var appLoginDonePage = template.Must(template.New("done").Parse(`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light"><title>juntos.lol</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#141414;color:#f2f2f2}
a{display:inline-block;padding:14px 28px;border-radius:999px;background:#ff7640;color:#250f07;font-weight:600;text-decoration:none}</style>
</head><body><a href="{{.}}">Voltar para o app</a></body></html>`))

// appLoginDone is the page the App Link opens over; a browser that kept it
// (the app is missing or the link was not verified) gets a tap back to it.
func (a *accountRoutes) appLoginDone(c *gin.Context) {
	code := c.Query("code")
	link := template.URL("juntos://signed-in?code=" + url.QueryEscape(code))
	c.Header("Cache-Control", "no-store")
	c.Header("Content-Type", "text/html; charset=utf-8")
	c.Status(http.StatusOK)
	_ = appLoginDonePage.Execute(c.Writer, link)
}

type appRedeemBody struct {
	Code     string `json:"code"`
	Verifier string `json:"verifier"`
}

// redeemAppLogin turns the code and its verifier into the app's session cookie.
func (a *accountRoutes) redeemAppLogin(c *gin.Context) {
	var body appRedeemBody
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4096)
	if err := c.ShouldBindJSON(&body); err != nil || body.Code == "" || len(body.Verifier) < 43 || len(body.Verifier) > 128 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	handoff, ok := a.handoffs.take(body.Code)
	sum := sha256.Sum256([]byte(body.Verifier))
	if !ok || subtle.ConstantTimeCompare([]byte(base64.RawURLEncoding.EncodeToString(sum[:])), []byte(handoff.challenge)) != 1 {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "bad_code"})
		return
	}
	http.SetCookie(c.Writer, &http.Cookie{
		Name: accountCookie, Value: handoff.session, Path: "/", MaxAge: int((30 * 24 * time.Hour) / time.Second),
		HttpOnly: true, Secure: a.secureCookie(c.Request), SameSite: http.SameSiteLaxMode,
	})
	c.Status(http.StatusNoContent)
}

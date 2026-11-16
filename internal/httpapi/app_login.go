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

// takeChallenge spends the code minted for the challenge, for an app that
// waits for the browser instead of being handed the code by a link.
func (h *appHandoffs) takeChallenge(challenge string) (appHandoff, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for code, handoff := range h.codes {
		if subtle.ConstantTimeCompare([]byte(handoff.challenge), []byte(challenge)) != 1 {
			continue
		}
		delete(h.codes, code)
		if h.now().After(handoff.expires) {
			return appHandoff{}, false
		}
		return handoff, true
	}
	return appHandoff{}, false
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
	poll := c.Query("poll") == "1"
	if !ok {
		back := "/api/auth/app?challenge=" + url.QueryEscape(challenge)
		if poll {
			back += "&poll=1"
		}
		c.Redirect(http.StatusFound, "/api/auth/discord?next="+url.QueryEscape(back))
		return
	}
	if poll {
		// The desktop app waits for this browser, so the browser must say
		// yes to the code the app shows: a link sent by someone else would
		// otherwise sign their app in as this account.
		c.Header("Cache-Control", "no-store")
		c.Header("Content-Type", "text/html; charset=utf-8")
		c.Status(http.StatusOK)
		_ = appConfirmPage.Execute(c.Writer, struct {
			Nickname, Code, Challenge string
		}{me.Nickname, PairingCode(challenge), challenge})
		return
	}
	a.mintHandoff(c, me.ID, challenge, false)
}

// confirmAppLogin is the yes on the confirmation page.
func (a *accountRoutes) confirmAppLogin(c *gin.Context) {
	challenge := c.PostForm("challenge")
	if !appChallenge.MatchString(challenge) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad_challenge"})
		return
	}
	me, ok := a.viewer(c, true)
	if !ok {
		return
	}
	a.mintHandoff(c, me.ID, challenge, true)
}

// PairingCode is the six letters the app and the browser both show for a
// challenge, to be compared before saying yes.
func PairingCode(challenge string) string {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	sum := sha256.Sum256([]byte("juntos-app-login:" + challenge))
	code := make([]byte, 6)
	for i := range code {
		code[i] = alphabet[int(sum[i])%len(alphabet)]
	}
	return string(code)
}

var appConfirmPage = template.Must(template.New("confirm").Parse(`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light"><title>juntos.lol</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#141414;color:#f2f2f2}
main{display:grid;justify-items:center;gap:22px;text-align:center;padding:24px}h1{margin:0;font-size:22px;font-weight:600}
.code{font:600 34px/1 ui-monospace,monospace;letter-spacing:.18em;padding:16px 22px;border-radius:16px;background:#232323}
button{font:inherit;border:0;cursor:pointer;padding:14px 32px;border-radius:999px;background:#ff7640;color:#250f07;font-weight:600}</style>
</head><body><main><h1>Entrar no app como {{.Nickname}}?</h1><div class="code">{{.Code}}</div>
<form method="post" action="/api/auth/app/confirm"><input type="hidden" name="challenge" value="{{.Challenge}}"><button type="submit">Entrar</button></form>
</main></body></html>`))

func (a *accountRoutes) mintHandoff(c *gin.Context, accountID int64, challenge string, poll bool) {
	ctx := c.Request.Context()
	session, err := a.accounts.StartSession(ctx, accountID)
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
	if poll {
		// The app waits on its own: the code never leaves the server.
		c.Redirect(http.StatusSeeOther, AppLoginDonePath+"?app=desktop")
		return
	}
	c.Redirect(http.StatusFound, AppLoginDonePath+"?code="+url.QueryEscape(code))
}

var appLoginDonePage = template.Must(template.New("done").Parse(`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light"><title>juntos.lol</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#141414;color:#f2f2f2}
main{display:grid;justify-items:center;gap:20px;text-align:center}h1{margin:0;font-size:22px;font-weight:600}
a{display:inline-block;padding:14px 28px;border-radius:999px;background:#ff7640;color:#250f07;font-weight:600;text-decoration:none}</style>
</head><body><main>{{if .Desktop}}<h1>Pronto, pode voltar para o app</h1>{{end}}<a href="{{.Link}}">Voltar para o app</a></main>
{{if .Desktop}}<script>location.href={{.Link}}</script>{{end}}</body></html>`))

// appLoginDone is the page the App Link opens over; a browser that kept it
// (the app is missing or the link was not verified) gets a tap back to it.
func (a *accountRoutes) appLoginDone(c *gin.Context) {
	desktop := c.Query("app") == "desktop"
	link := template.URL("juntos://signed-in?code=" + url.QueryEscape(c.Query("code")))
	if desktop {
		link = "juntos://signed-in"
	}
	c.Header("Cache-Control", "no-store")
	c.Header("Content-Type", "text/html; charset=utf-8")
	c.Status(http.StatusOK)
	_ = appLoginDonePage.Execute(c.Writer, struct {
		Link    template.URL
		Desktop bool
	}{link, desktop})
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

// pollAppLogin is the desktop app asking, with its verifier, whether the
// sign-in it opened in the browser finished; 202 while it has not.
func (a *accountRoutes) pollAppLogin(c *gin.Context) {
	var body struct {
		Verifier string `json:"verifier"`
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4096)
	if err := c.ShouldBindJSON(&body); err != nil || len(body.Verifier) < 43 || len(body.Verifier) > 128 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	sum := sha256.Sum256([]byte(body.Verifier))
	handoff, ok := a.handoffs.takeChallenge(base64.RawURLEncoding.EncodeToString(sum[:]))
	if !ok {
		c.Header("Cache-Control", "no-store")
		c.JSON(http.StatusAccepted, gin.H{"state": "pending"})
		return
	}
	http.SetCookie(c.Writer, &http.Cookie{
		Name: accountCookie, Value: handoff.session, Path: "/", MaxAge: int((30 * 24 * time.Hour) / time.Second),
		HttpOnly: true, Secure: a.secureCookie(c.Request), SameSite: http.SameSiteLaxMode,
	})
	c.Status(http.StatusNoContent)
}

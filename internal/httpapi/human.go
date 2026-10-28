package httpapi

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/giulianoo0/ss/internal/config"
)

const (
	humanCookie      = "ss_human"
	humanTTL         = 24 * time.Hour
	humanAction      = "human"
	maxTurnstileSize = 2048
	siteverifyURL    = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
)

// siteverifyResult is what Turnstile says about one token.
type siteverifyResult struct {
	Success    bool     `json:"success"`
	Action     string   `json:"action"`
	Hostname   string   `json:"hostname"`
	ErrorCodes []string `json:"error-codes"`
}

// HumanGate lets a browser that solved Turnstile open and enter rooms for a
// day: the token is spent once on POST /api/human, which leaves a signed
// cookie behind. A nil gate asks nobody.
type HumanGate struct {
	siteKey    string
	key        []byte
	secret     string
	hostnames  []string
	behindEdge bool
	secure     bool
	failures   *windowLimiter
	verify     func(ctx context.Context, secret, token, ip string) (siteverifyResult, error)
	now        func() time.Time
}

func NewHumanGate(cfg config.Config) *HumanGate {
	if cfg.TurnstileSecret == "" {
		return nil
	}
	key := sha256.Sum256([]byte("ss-human:" + cfg.TurnstileSecret))
	return &HumanGate{
		siteKey:    cfg.TurnstileSiteKey,
		key:        key[:],
		secret:     cfg.TurnstileSecret,
		hostnames:  cfg.TurnstileHostnames,
		behindEdge: cfg.BehindCloudflare,
		secure:     strings.HasPrefix(cfg.PublicOrigin, "https://"),
		failures:   newWindowLimiter(10, time.Hour),
		verify:     siteverify,
		now:        time.Now,
	}
}

// Require refuses a request whose browser has not passed Turnstile lately.
func (g *HumanGate) Require() gin.HandlerFunc {
	return func(c *gin.Context) {
		if reason := g.refusal(c.Request); reason != "" {
			slog.InfoContext(c.Request.Context(), "human check", "result", "required", "reason", reason,
				"path", c.FullPath())
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "human_required"})
			return
		}
		c.Next()
	}
}

// Verify spends a Turnstile token and leaves the cookie Require looks for.
func (g *HumanGate) Verify(c *gin.Context) {
	if g == nil {
		c.JSON(http.StatusOK, gin.H{"expiresAt": time.Now().Add(humanTTL).UTC()})
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4<<10)
	var request struct {
		Token string `json:"token"`
	}
	if err := c.ShouldBindJSON(&request); err != nil || request.Token == "" || len(request.Token) > maxTurnstileSize {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()
	ip := requestIP(c.Request, g.behindEdge)
	result, err := g.verify(ctx, g.secret, request.Token, ip)
	if err != nil || !result.Success || result.Action != humanAction || !slices.Contains(g.hostnames, result.Hostname) {
		reason := strings.Join(result.ErrorCodes, ",")
		if err != nil {
			reason = "siteverify: " + err.Error()
		}
		slog.WarnContext(ctx, "human check", "result", "failed", "reason", reason, "action", result.Action,
			"hostname", result.Hostname)
		c.JSON(http.StatusForbidden, gin.H{"error": "human_failed"})
		return
	}
	slog.InfoContext(ctx, "human check", "result", "passed")
	expires := g.now().Add(humanTTL)
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     humanCookie,
		Value:    g.sign(expires),
		Path:     "/",
		Expires:  expires,
		HttpOnly: true,
		Secure:   g.secure || secureRequest(c.Request),
		SameSite: http.SameSiteLaxMode,
	})
	c.JSON(http.StatusOK, gin.H{"expiresAt": expires.UTC()})
}

// Failure logs a check that died in the browser (script blocked, widget
// error, timeout), which would otherwise never reach the server.
func (g *HumanGate) Failure(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 512)
	var report struct {
		Reason string `json:"reason"`
	}
	if g == nil || c.ShouldBindJSON(&report) != nil || report.Reason == "" || len(report.Reason) > 64 {
		c.Status(http.StatusNoContent)
		return
	}
	if g.failures.allow(requestIP(c.Request, g.behindEdge)) {
		slog.WarnContext(c.Request.Context(), "human check", "result", "client_failed", "reason", report.Reason,
			"ua", c.Request.UserAgent())
	}
	c.Status(http.StatusNoContent)
}

func (g *HumanGate) sign(expires time.Time) string {
	stamp := strconv.FormatInt(expires.Unix(), 10)
	mac := hmac.New(sha256.New, g.key)
	mac.Write([]byte(stamp))
	return stamp + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// refusal says why a request has not passed lately, or "" when it has.
func (g *HumanGate) refusal(r *http.Request) string {
	if g == nil {
		return ""
	}
	cookie, err := r.Cookie(humanCookie)
	if err != nil {
		return "no_cookie"
	}
	stamp, _, ok := strings.Cut(cookie.Value, ".")
	unix, err := strconv.ParseInt(stamp, 10, 64)
	if !ok || err != nil || !hmac.Equal([]byte(cookie.Value), []byte(g.sign(time.Unix(unix, 0)))) {
		return "forged"
	}
	if !g.now().Before(time.Unix(unix, 0)) {
		return "expired"
	}
	return ""
}

func siteverify(ctx context.Context, secret, token, ip string) (siteverifyResult, error) {
	form := url.Values{"secret": {secret}, "response": {token}}
	if ip != "" {
		form.Set("remoteip", ip)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, siteverifyURL, strings.NewReader(form.Encode()))
	if err != nil {
		return siteverifyResult{}, err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return siteverifyResult{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return siteverifyResult{}, errors.New("siteverify: " + response.Status)
	}
	var result siteverifyResult
	if err := json.NewDecoder(http.MaxBytesReader(nil, response.Body, 16<<10)).Decode(&result); err != nil {
		return siteverifyResult{}, err
	}
	return result, nil
}

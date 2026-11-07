package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/giulianoo0/ss/internal/account"
	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/extension"
)

// ExtensionAccess is what the extension routes need. Using an extension needs
// no account; registering one needs one of the publishing accounts, and a nil
// Accounts leaves registering closed.
type ExtensionAccess struct {
	Registry *extension.Registry
	GitHub   *extension.GitHub
	Accounts *account.Store
	Quota    *Quota
	// Human is the gate a media ticket waits behind; nil asks nobody.
	Human gin.HandlerFunc
}

type extensionView struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Sub    string `json:"sub"`
	Source string `json:"source"`
	Icon   string `json:"icon,omitempty"`
}

// RegisterExtensionRoutes mounts the registry: the lookup the site installs
// an id with, the one the host Worker makes by subdomain, registering a
// GitHub repository and asking for its newest commit.
func RegisterExtensionRoutes(rg *gin.RouterGroup, cfg config.Config, access ExtensionAccess) {
	rg.GET("/extensions/host/:sub", extensionHost(access.Registry))
	rg.GET("/extensions/:id", extensionByID(access.Registry))
	rg.GET("/extensions/:id/latest", latestExtension(access))
	rg.POST("/extensions", sameOrigin(cfg), registerExtension(cfg, access))
	human := access.Human
	if human == nil {
		human = func(*gin.Context) {}
	}
	rg.POST("/extensions/media-ticket", sameOrigin(cfg), human, mediaTicket(cfg, newWindowLimiter(mediaTicketsPerHour, time.Hour)))
}

const (
	mediaTicketTTL      = 6 * time.Hour
	mediaTicketsPerHour = 240
	maxTicketURL        = 2048
)

// mediaTicket signs one url for an extension's media proxy. The page asks
// for it when a CDN sends no CORS; the proxy refuses a request without one,
// so the Origin a script can write itself is no longer the only lock.
func mediaTicket(cfg config.Config, limiter *windowLimiter) gin.HandlerFunc {
	key := []byte(cfg.ExtensionMediaKey)
	return func(c *gin.Context) {
		if len(key) == 0 {
			c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "media_proxy_off"})
			return
		}
		var body struct {
			Sub string `json:"sub"`
			URL string `json:"url"`
		}
		if err := c.ShouldBindJSON(&body); err != nil || !extension.ValidSub(body.Sub) || !proxiableURL(body.URL) {
			c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "bad_request"})
			return
		}
		if !limiter.allow(requestIP(c.Request, cfg.BehindCloudflare)) {
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": "quota_exceeded"})
			return
		}
		expires := time.Now().Add(mediaTicketTTL)
		c.JSON(http.StatusOK, gin.H{"ticket": extension.MediaTicket(key, body.Sub, body.URL, expires), "expiresAt": expires.UTC()})
	}
}

// proxiableURL is what the proxy would fetch at all: https, no port, no
// credentials. Whether the host is one of the extension's is the proxy's call.
func proxiableURL(raw string) bool {
	if raw == "" || len(raw) > maxTicketURL {
		return false
	}
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && u.Host != "" && u.Port() == "" && u.User == nil
}

// entryByID writes the 404 or 500 itself when ok is false.
func entryByID(c *gin.Context, registry *extension.Registry) (extension.Entry, bool) {
	id := c.Param("id")
	if !extension.ValidID(id) {
		c.AbortWithStatus(http.StatusNotFound)
		return extension.Entry{}, false
	}
	entry, err := registry.ByID(c.Request.Context(), id)
	if errors.Is(err, extension.ErrNotFound) {
		c.AbortWithStatus(http.StatusNotFound)
		return extension.Entry{}, false
	}
	if err != nil {
		slog.ErrorContext(c.Request.Context(), "extension by id", "error", err)
		c.AbortWithStatus(http.StatusInternalServerError)
		return extension.Entry{}, false
	}
	return entry, true
}

func extensionByID(registry *extension.Registry) gin.HandlerFunc {
	return func(c *gin.Context) {
		if e, ok := entryByID(c, registry); ok {
			c.JSON(http.StatusOK, extensionView{ID: e.ID, Name: e.Name, Sub: e.Sub, Source: e.Source, Icon: e.Icon})
		}
	}
}

func extensionHost(registry *extension.Registry) gin.HandlerFunc {
	return func(c *gin.Context) {
		sub := c.Param("sub")
		if !extension.ValidSub(sub) {
			c.AbortWithStatus(http.StatusNotFound)
			return
		}
		entry, err := registry.BySub(c.Request.Context(), sub)
		if errors.Is(err, extension.ErrNotFound) {
			c.AbortWithStatus(http.StatusNotFound)
			return
		}
		if err != nil {
			slog.ErrorContext(c.Request.Context(), "extension by sub", "error", err)
			c.AbortWithStatus(http.StatusInternalServerError)
			return
		}
		c.Header("Cache-Control", "public, max-age=60")
		c.JSON(http.StatusOK, gin.H{"id": entry.ID, "source": entry.Source})
	}
}

func latestExtension(access ExtensionAccess) gin.HandlerFunc {
	return func(c *gin.Context) {
		ctx := c.Request.Context()
		entry, ok := entryByID(c, access.Registry)
		if !ok {
			return
		}
		sha, err := access.GitHub.Head(ctx, strings.TrimPrefix(entry.Source, "github:"))
		if err != nil {
			slog.WarnContext(ctx, "extension latest", "id", entry.ID, "error", err)
			c.AbortWithStatusJSON(http.StatusBadGateway, gin.H{"error": "github_unavailable"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"sha": sha})
	}
}

// registrant is the account the request is signed in as, 0 for nobody.
func registrant(c *gin.Context, accounts *account.Store) (int64, error) {
	if accounts == nil {
		return 0, nil
	}
	cookie, err := c.Cookie(accountCookie)
	if err != nil {
		return 0, nil
	}
	return accounts.SessionAccount(c.Request.Context(), cookie)
}

func registerExtension(cfg config.Config, access ExtensionAccess) gin.HandlerFunc {
	return func(c *gin.Context) {
		ctx := c.Request.Context()
		accountID, err := registrant(c, access.Accounts)
		if err != nil {
			slog.ErrorContext(ctx, "extension registrant", "error", err)
			c.AbortWithStatus(http.StatusInternalServerError)
			return
		}
		if accountID == 0 {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "account_required"})
			return
		}
		if !cfg.CanPublishExtensions(accountID) {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "publisher_only"})
			return
		}
		allowed, err := access.Quota.CheckExtensionRegister(ctx, accountID)
		if err != nil {
			slog.ErrorContext(ctx, "extension register quota check", "error", err)
			c.AbortWithStatus(http.StatusInternalServerError)
			return
		}
		if !allowed {
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": "quota_exceeded", "reason": "extension_register_limit"})
			return
		}
		var body struct {
			Repo string `json:"repo"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "bad_repo"})
			return
		}
		repo, err := extension.ParseRepo(body.Repo)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "bad_repo"})
			return
		}
		err = access.GitHub.CheckOpenSource(ctx, repo)
		if errors.Is(err, extension.ErrRepoNotFound) {
			c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "repo_not_found"})
			return
		}
		if errors.Is(err, extension.ErrNotOpenSource) {
			c.AbortWithStatusJSON(http.StatusUnprocessableEntity, gin.H{"error": "not_open_source"})
			return
		}
		if err != nil {
			slog.WarnContext(ctx, "extension repo", "repo", repo, "error", err)
			c.AbortWithStatusJSON(http.StatusBadGateway, gin.H{"error": "github_unavailable"})
			return
		}
		sha, err := access.GitHub.Head(ctx, repo)
		if errors.Is(err, extension.ErrRepoNotFound) {
			c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "repo_not_found"})
			return
		}
		if err != nil {
			slog.WarnContext(ctx, "extension head", "repo", repo, "error", err)
			c.AbortWithStatusJSON(http.StatusBadGateway, gin.H{"error": "github_unavailable"})
			return
		}
		manifest, err := access.GitHub.Manifest(ctx, repo, sha)
		if errors.Is(err, extension.ErrBadManifest) {
			c.AbortWithStatusJSON(http.StatusUnprocessableEntity, gin.H{"error": "bad_manifest", "detail": err.Error()})
			return
		}
		if err != nil {
			slog.WarnContext(ctx, "extension manifest", "repo", repo, "error", err)
			c.AbortWithStatusJSON(http.StatusBadGateway, gin.H{"error": "github_unavailable"})
			return
		}
		entry, created, err := access.Registry.Register(ctx, extension.Registration{
			ID: manifest.ID, Name: manifest.Name, Source: "github:" + repo, Icon: manifest.Icon, Account: accountID,
		})
		if errors.Is(err, extension.ErrIDTaken) {
			c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "id_taken"})
			return
		}
		if err != nil {
			slog.ErrorContext(ctx, "register extension", "error", err)
			c.AbortWithStatus(http.StatusInternalServerError)
			return
		}
		status := http.StatusOK
		if created {
			status = http.StatusCreated
			slog.InfoContext(ctx, "extension registered", "id", entry.ID, "source", entry.Source, "account", accountID)
		}
		c.JSON(status, gin.H{"id": entry.ID, "sub": entry.Sub, "sha": sha, "manifest": manifest})
	}
}

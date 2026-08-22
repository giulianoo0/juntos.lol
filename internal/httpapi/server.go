// Package httpapi assembles the HTTP API of the server.
package httpapi

import (
	"net/http"
	"net/http/httputil"
	"net/url"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
	syncapi "github.com/giulianoo0/ss/internal/sync"
)

// ServerOption tunes the engine without forcing every caller to pass hooks
// they do not have.
type ServerOption func(*serverOptions)

type serverOptions struct {
	sourceHooks       SourceHooks
	ingestor          TorrentIngestor
	urlIngestor       URLIngestor
	subtitlePublisher SubtitlePublisher
}

// WithSourceHooks connects the room source endpoint to the media pipeline.
func WithSourceHooks(hooks SourceHooks) ServerOption {
	return func(o *serverOptions) { o.sourceHooks = hooks }
}

// WithTorrentIngestor enables the endpoint that pulls a torrent file in
// server-side. Without it, torrent rooms fall back to uploading from the
// browser.
func WithTorrentIngestor(ingestor TorrentIngestor) ServerOption {
	return func(o *serverOptions) { o.ingestor = ingestor }
}

// WithURLIngestor enables opening a room from a url a plugin produced.
func WithURLIngestor(ingestor URLIngestor) ServerOption {
	return func(o *serverOptions) { o.urlIngestor = ingestor }
}

// WithSubtitlePublisher sends browser-extracted subtitles to the bucket they
// are served from. Without it they are stored but never delivered.
func WithSubtitlePublisher(publisher SubtitlePublisher) ServerOption {
	return func(o *serverOptions) { o.subtitlePublisher = publisher }
}

// NewServer assembles the HTTP engine: the health check plus the room API.
// Later features (media serving, WebSocket, screenshare) extend this.
func NewServer(cfg config.Config, store *room.Store, hub *syncapi.Hub, opts ...ServerOption) *gin.Engine {
	var options serverOptions
	for _, apply := range opts {
		apply(&options)
	}
	r := gin.Default()
	// The app is bound to loopback behind the edge proxy. Do not accept
	// client-controlled forwarding headers as authoritative addresses.
	if err := r.SetTrustedProxies(nil); err != nil {
		panic("configure trusted proxies: " + err.Error())
	}
	r.Use(requestMetrics())
	r.Use(privacyHeaders())
	r.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	RegisterRoomRoutes(r.Group("/api"), store, cfg)
	RegisterScreenshareRoute(r.Group("/api"), store, cfg, hub)
	RegisterMediaRoutes(r, store)
	var onSubsStored func(string)
	if hub != nil {
		onSubsStored = hub.NotifyRoomUpdated
	}
	RegisterSubtitlesRoute(r.Group("/api"), store, cfg, options.subtitlePublisher, onSubsStored)
	// hub is a typed nil in tests; pass the interface only when it is real so
	// the authorizer check inside the handler stays meaningful.
	var authorizer memberAuthorizer
	if hub != nil {
		authorizer = hub
	}
	RegisterSourceRoute(r.Group("/api"), store, cfg, authorizer, options.sourceHooks)
	RegisterTorrentRoute(r.Group("/api"), store, cfg, options.ingestor)
	RegisterURLSourceRoute(r.Group("/api"), store, cfg, options.urlIngestor)
	registerTorrentBridge(r, cfg.TorrentBridgeURL)
	if hub != nil {
		r.GET("/ws/rooms/:id", hub.HandleWS)
	}
	registerFrontend(r, cfg.WebDir)
	return r
}

func registerTorrentBridge(r *gin.Engine, rawURL string) {
	if rawURL == "" {
		return
	}
	target, err := url.Parse(rawURL)
	if err != nil || target.Scheme != "http" || target.Host == "" {
		panic("invalid torrent bridge URL")
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
		http.Error(w, `{"error":"torrent bridge unavailable"}`, http.StatusBadGateway)
	}
	r.Any("/api/torrent-bridge/*path", func(c *gin.Context) {
		// The whole-file stream exists for the server-side ingest, which
		// reaches the bridge directly. Proxying it would hand anyone an
		// unmetered pipe for a 10 GB file over a single request.
		if c.Param("path") == "/stream" {
			c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
			return
		}
		proxy.ServeHTTP(c.Writer, c.Request)
	})
}

func privacyHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Referrer-Policy", "no-referrer")
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("X-Frame-Options", "DENY")
		// The plugin worker gets a policy of its own, and it is the only layer
		// of that sandbox plugin code cannot reach around from the inside.
		// `default-src 'none'` removes every network API from that context —
		// including any the bootstrap's allowlist missed — and closes
		// `import('https://…')`, which fetches the url before rejecting it and
		// is therefore an exfiltration channel nothing inside a worker can
		// take away. `script-src blob:` is the one exception it needs to exist
		// at all: the plugin's own module is imported from a blob url. What it
		// does not allow is https or 'self'.
		//
		// Matched by directory, not by filename prefix: vite is configured to
		// emit every chunk of the worker graph in here, so an import added to
		// worker.ts cannot split a chunk out to a path with no policy.
		if strings.HasPrefix(c.Request.URL.Path, "/assets/plugin-worker/") {
			c.Header("Content-Security-Policy", "default-src 'none'; script-src blob:")
		}
		if strings.HasPrefix(c.Request.URL.Path, "/api/") || strings.HasPrefix(c.Request.URL.Path, "/ws/") {
			c.Header("Cache-Control", "no-store")
		}
		c.Next()
	}
}

func registerFrontend(r *gin.Engine, webDir string) {
	if webDir == "" {
		return
	}
	r.Static("/assets", filepath.Join(webDir, "assets"))
	r.Static("/docs", filepath.Join(webDir, "docs"))
	for _, name := range []string{"favicon.svg", "icons.svg", "social-card.png", "oembed.json"} {
		r.StaticFile("/"+name, filepath.Join(webDir, name))
	}
	r.NoRoute(func(c *gin.Context) {
		// A documentation address that is wrong should say it is wrong, not
		// open the application.
		if c.Request.Method != http.MethodGet || strings.HasPrefix(c.Request.URL.Path, "/api/") ||
			strings.HasPrefix(c.Request.URL.Path, "/media/") || strings.HasPrefix(c.Request.URL.Path, "/ws/") ||
			strings.HasPrefix(c.Request.URL.Path, "/docs/") {
			c.Status(http.StatusNotFound)
			return
		}
		c.File(filepath.Join(webDir, "index.html"))
	})
}

// Package httpapi assembles the HTTP API of the server.
package httpapi

import (
	"net/http"
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
	subtitlePublisher SubtitlePublisher
	clientMediaBucket ClientMediaBucket
	clientMediaHooks  ClientMediaHooks
	torrentAccess     TorrentAccess
	workerLink        gin.HandlerFunc
}

// WithTorrents mounts the torrent routes over the worker fleet, and the
// control link the workers dial.
func WithTorrents(access TorrentAccess, workerLink gin.HandlerFunc) ServerOption {
	return func(o *serverOptions) {
		o.torrentAccess = access
		o.workerLink = workerLink
	}
}

// WithSourceHooks connects the room source endpoint to the media pipeline.
func WithSourceHooks(hooks SourceHooks) ServerOption {
	return func(o *serverOptions) { o.sourceHooks = hooks }
}

// WithSubtitlePublisher sends browser-extracted subtitles to the bucket they
// are served from. Without it they are stored but never delivered.
func WithSubtitlePublisher(publisher SubtitlePublisher) ServerOption {
	return func(o *serverOptions) { o.subtitlePublisher = publisher }
}

// WithClientMedia enables the client media pipeline: the host's browser
// remuxes the source itself and writes segments straight into the bucket
// through presigned URLs. It is the only way media reaches a room.
func WithClientMedia(bucket ClientMediaBucket, hooks ClientMediaHooks) ServerOption {
	return func(o *serverOptions) {
		o.clientMediaBucket = bucket
		o.clientMediaHooks = hooks
	}
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
	RegisterClientMediaRoutes(r.Group("/api"), store, cfg, options.clientMediaBucket, options.clientMediaHooks)
	RegisterTorrentRoutes(r.Group("/api"), cfg, options.torrentAccess)
	if hub != nil {
		r.GET("/ws/rooms/:id", hub.HandleWS)
	}
	if options.workerLink != nil {
		r.GET("/ws/worker-link", options.workerLink)
	}
	RegisterRelayRoute(r, options.torrentAccess.Service)
	registerFrontend(r, cfg.WebDir)
	return r
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

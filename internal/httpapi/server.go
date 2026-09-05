// Package httpapi assembles the HTTP API of the server.
package httpapi

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
	syncapi "github.com/giulianoo0/ss/internal/sync"
)

type ServerOption func(*serverOptions)

type serverOptions struct {
	sourceHooks       SourceHooks
	subtitlePublisher SubtitlePublisher
	clientMediaBucket ClientMediaBucket
	clientMediaHooks  ClientMediaHooks
	torrentAccess     TorrentAccess
	workerLink        gin.HandlerFunc
	pluginSessions    *Sessions
	pluginQuota       *Quota
}

// WithPluginFetch puts a session and an hourly budget on the plugin hop.
func WithPluginFetch(sessions *Sessions, quota *Quota) ServerOption {
	return func(o *serverOptions) {
		o.pluginSessions = sessions
		o.pluginQuota = quota
	}
}

func WithTorrents(access TorrentAccess, workerLink gin.HandlerFunc) ServerOption {
	return func(o *serverOptions) {
		o.torrentAccess = access
		o.workerLink = workerLink
	}
}

func WithSourceHooks(hooks SourceHooks) ServerOption {
	return func(o *serverOptions) { o.sourceHooks = hooks }
}

// WithSubtitlePublisher sends browser-extracted subtitles to the bucket they are
// served from; without it they are stored but never delivered.
func WithSubtitlePublisher(publisher SubtitlePublisher) ServerOption {
	return func(o *serverOptions) { o.subtitlePublisher = publisher }
}

// WithClientMedia enables the only path by which media reaches a room: the host's
// browser remuxes the source and writes segments into the bucket via presigned URLs.
func WithClientMedia(bucket ClientMediaBucket, hooks ClientMediaHooks) ServerOption {
	return func(o *serverOptions) {
		o.clientMediaBucket = bucket
		o.clientMediaHooks = hooks
	}
}

func NewServer(cfg config.Config, store *room.Store, hub *syncapi.Hub, opts ...ServerOption) *gin.Engine {
	var options serverOptions
	for _, apply := range opts {
		apply(&options)
	}
	r := gin.Default()
	if err := r.SetTrustedProxies(nil); err != nil {
		panic("configure trusted proxies: " + err.Error())
	}
	r.Use(privacyHeaders())
	r.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	RegisterRoomRoutes(r.Group("/api"), store, cfg)
	waiter := newPlaylistWaiter()
	RegisterMediaRoutes(r, store, waiter)
	options.clientMediaHooks.NotifyPlaylists = waiter.Notify
	if hub != nil && options.clientMediaHooks.NotifyRoomMedia == nil {
		options.clientMediaHooks.NotifyRoomMedia = hub.NotifyRoomMedia
	}
	var onSubsStored func(string)
	if hub != nil {
		onSubsStored = hub.NotifyRoomUpdated
	}
	var screenAuthorizer memberAuthorizer
	if hub != nil {
		screenAuthorizer = hub
	}
	RegisterScreenshareRoutes(r.Group("/api"), store, cfg, screenAuthorizer, onSubsStored)
	RegisterSubtitlesRoute(r.Group("/api"), store, cfg, options.subtitlePublisher, onSubsStored)
	var authorizer memberAuthorizer
	if hub != nil {
		authorizer = hub
	}
	RegisterSourceRoute(r.Group("/api"), store, cfg, authorizer, options.sourceHooks)
	RegisterClientMediaRoutes(r.Group("/api"), store, cfg, options.clientMediaBucket, options.clientMediaHooks)
	RegisterTorrentRoutes(r.Group("/api"), cfg, options.torrentAccess)
	if hub != nil {
		r.GET("/ws/rooms/:id", hub.HandleWS)
		r.GET("/api/live", func(c *gin.Context) {
			_, members := hub.Live()
			census, err := store.Census(c.Request.Context())
			if err != nil {
				c.JSON(http.StatusOK, gin.H{"members": members})
				return
			}
			c.JSON(http.StatusOK, gin.H{"rooms": census.Total, "members": members})
		})
	}
	if options.workerLink != nil {
		r.GET("/ws/worker-link", options.workerLink)
	}
	RegisterRelayRoute(r, options.torrentAccess.Service)
	RegisterPluginFetchRoute(r.Group("/api"), NewPluginFetcher(cfg), options.pluginSessions, options.pluginQuota)
	registerFrontend(r, cfg.WebDir)
	return r
}

func privacyHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Referrer-Policy", "no-referrer")
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("X-Frame-Options", "DENY")
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
	entries, _ := os.ReadDir(webDir)
	for _, entry := range entries {
		if entry.IsDir() || entry.Name() == "index.html" {
			continue
		}
		r.StaticFile("/"+entry.Name(), filepath.Join(webDir, entry.Name()))
	}
	r.NoRoute(func(c *gin.Context) {
		if c.Request.Method != http.MethodGet || strings.HasPrefix(c.Request.URL.Path, "/api/") ||
			strings.HasPrefix(c.Request.URL.Path, "/media/") || strings.HasPrefix(c.Request.URL.Path, "/ws/") ||
			strings.HasPrefix(c.Request.URL.Path, "/docs/") {
			c.Status(http.StatusNotFound)
			return
		}
		c.File(filepath.Join(webDir, "index.html"))
	})
}

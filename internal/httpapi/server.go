// Package httpapi assembles the HTTP API of the server.
package httpapi

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/giulianoo0/ss/internal/account"
	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
	syncapi "github.com/giulianoo0/ss/internal/sync"
	"github.com/giulianoo0/ss/internal/usage"
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
	discord           http.Handler
	accounts          *account.Store
	usage             *usage.Counter
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
	var roomReaders memberAuthorizer
	if hub != nil {
		roomReaders = hub
	}
	human := NewHumanGate(cfg)
	r.GET("/api/config", publicConfig(cfg))
	r.POST("/api/human", human.Verify)
	r.POST("/api/human/failure", human.Failure)
	r.POST("/api/visit", countVisit(options.usage, cfg.BehindCloudflare))
	data := dataSources{usage: options.usage, accounts: options.accounts, rooms: store}
	if hub != nil {
		data.live = hub.Live
	}
	if options.torrentAccess.Service != nil {
		data.fleet = options.torrentAccess.Service.Fleet
	}
	r.GET("/api/data", serveData(data))
	counted := r.Group("/api", countRoutes(options.usage))
	RegisterRoomRoutes(counted, store, cfg, roomReaders)
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
	var screenAuthorizer stageAuthorizer
	if hub != nil {
		screenAuthorizer = hub
	}
	RegisterScreenshareRoutes(r.Group("/api"), store, cfg, screenAuthorizer, onSubsStored)
	RegisterCallRoutes(r.Group("/api"), store, cfg, screenAuthorizer)
	RegisterSubtitlesRoute(r.Group("/api"), store, cfg, options.subtitlePublisher, onSubsStored)
	var authorizer stageAuthorizer
	if hub != nil {
		authorizer = hub
	}
	RegisterSourceRoute(counted, store, cfg, authorizer, options.sourceHooks)
	RegisterClientMediaRoutes(r.Group("/api"), store, cfg, options.clientMediaBucket, options.clientMediaHooks)
	RegisterTorrentRoutes(r.Group("/api"), cfg, options.torrentAccess)
	RegisterYoutubeRoutes(r.Group("/api"), cfg, options.torrentAccess)
	RegisterLiveRoutes(r.Group("/api"), store, cfg, authorizer, options.sourceHooks, options.torrentAccess.Service)
	if hub != nil {
		RegisterJoinRoutes(r.Group("/api"), store, cfg, hub, hub, hub.NotifyRoomUpdated)
		r.GET("/ws/rooms/:id", human.Require(), hub.HandleWS)
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
	registerDiscordRoute(r, options.discord)
	if options.accounts != nil {
		var presence PresenceSource
		if hub != nil {
			presence = hub
		}
		RegisterAccountRoutes(r.Group("/api"), cfg, options.accounts, store, presence)
	}
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
	// Every folder of the build (assets, docs, emoji…) is served as files,
	// so a missing one answers 404 instead of opening the app shell.
	entries, _ := os.ReadDir(webDir)
	for _, entry := range entries {
		if entry.IsDir() {
			r.Static("/"+entry.Name(), filepath.Join(webDir, entry.Name()))
			continue
		}
		if entry.Name() == "index.html" {
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

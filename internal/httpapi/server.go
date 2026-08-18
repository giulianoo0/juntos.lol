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

// NewServer assembles the HTTP engine: the health check plus the room API.
// Later features (media serving, WebSocket, screenshare) extend this.
func NewServer(cfg config.Config, store *room.Store, hub *syncapi.Hub) *gin.Engine {
	r := gin.Default()
	// The app is bound to loopback behind the edge proxy. Do not accept
	// client-controlled forwarding headers as authoritative addresses.
	if err := r.SetTrustedProxies(nil); err != nil {
		panic("configure trusted proxies: " + err.Error())
	}
	r.Use(privacyHeaders())
	r.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	RegisterRoomRoutes(r.Group("/api"), store, cfg)
	RegisterScreenshareRoute(r.Group("/api"), store, cfg, hub)
	RegisterMediaRoutes(r, cfg, store)
	var onSubsStored func(string)
	if hub != nil {
		onSubsStored = hub.NotifyRoomUpdated
	}
	RegisterSubtitlesRoute(r.Group("/api"), store, cfg, onSubsStored)
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
	r.Any("/api/torrent-bridge/*path", gin.WrapH(proxy))
}

func privacyHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Referrer-Policy", "no-referrer")
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("X-Frame-Options", "DENY")
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
	for _, name := range []string{"favicon.svg", "icons.svg", "social-card.png", "oembed.json"} {
		r.StaticFile("/"+name, filepath.Join(webDir, name))
	}
	r.NoRoute(func(c *gin.Context) {
		if c.Request.Method != http.MethodGet || strings.HasPrefix(c.Request.URL.Path, "/api/") ||
			strings.HasPrefix(c.Request.URL.Path, "/media/") || strings.HasPrefix(c.Request.URL.Path, "/ws/") {
			c.Status(http.StatusNotFound)
			return
		}
		c.File(filepath.Join(webDir, "index.html"))
	})
}

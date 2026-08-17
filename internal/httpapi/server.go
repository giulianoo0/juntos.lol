// Package httpapi assembles the HTTP API of the server.
package httpapi

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
	syncapi "github.com/giulianoo0/ss/internal/sync"
)

// NewServer assembles the HTTP engine: the health check plus the room API.
// Later features (media serving, WebSocket, screenshare) extend this.
func NewServer(cfg config.Config, store *room.Store, hub *syncapi.Hub) *gin.Engine {
	r := gin.Default()
	r.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	RegisterRoomRoutes(r.Group("/api"), store, cfg)
	RegisterScreenshareRoute(r.Group("/api"), store, cfg)
	RegisterMediaRoutes(r, cfg, store)
	if hub != nil {
		r.GET("/ws/rooms/:id", hub.HandleWS)
	}
	return r
}

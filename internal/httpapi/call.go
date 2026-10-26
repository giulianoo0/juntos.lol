package httpapi

import (
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
)

type callTokenRequest struct {
	MemberID   string `json:"memberId"`
	Capability string `json:"capability"`
}

// RegisterCallRoutes mounts the relay handout for cameras and microphones.
// Every member may publish their own camera and voice, so unlike a screen the
// publish token goes to anyone in the room; the path under the room's secret
// base is what keeps one member's broadcast theirs.
func RegisterCallRoutes(rg *gin.RouterGroup, store *room.Store, cfg config.Config, authorizer memberAuthorizer) {
	rg.POST("/rooms/:id/call/token", callToken(store, cfg, authorizer))
}

// CallBroadcastPath is where one member's camera and microphone live on the relay.
func CallBroadcastPath(roomID, secret, memberID string) string {
	return ScreenBroadcastBase(roomID, secret) + "/av/" + memberID + ".hang"
}

func callToken(store *room.Store, cfg config.Config, authorizer memberAuthorizer) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !cfg.ScreenshareEnabled() {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "call_disabled"})
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxScreenshareBodyBytes)
		var request callTokenRequest
		if err := c.ShouldBindJSON(&request); err != nil || request.MemberID == "" || request.Capability == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		roomID := c.Param("id")
		storedRoom, err := store.Get(c.Request.Context(), roomID)
		if errors.Is(err, room.ErrNotFound) || err == nil && !storedRoom.ExpiresAt.After(time.Now()) {
			c.JSON(http.StatusNotFound, gin.H{"error": "room_not_found"})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
			return
		}
		if authorizer == nil || !authorizer.AuthorizeMember(roomID, request.MemberID, request.Capability) {
			c.JSON(http.StatusForbidden, gin.H{"error": "member_not_found"})
			return
		}
		secret, err := store.ScreenSecret(c.Request.Context(), roomID)
		if errors.Is(err, room.ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "room_not_found"})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"url":        cfg.MoqRelayURL + "/" + cfg.MoqSubscribeToken,
			"publishUrl": cfg.MoqRelayURL + "/" + cfg.MoqPublishToken,
			"base":       ScreenBroadcastBase(roomID, secret),
			"path":       CallBroadcastPath(roomID, secret, request.MemberID),
			"bridge":     cfg.MoqBridgeURL,
		})
	}
}

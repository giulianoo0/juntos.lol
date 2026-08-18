package httpapi

import (
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/livekit/protocol/auth"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
)

const maxScreenshareBodyBytes = 4 << 10

type screenshareTokenRequest struct {
	MemberID   string `json:"memberId" binding:"required"`
	Capability string `json:"capability" binding:"required"`
}

type memberAuthorizer interface {
	AuthorizeMember(roomID, memberID, capability string) bool
}

// RegisterScreenshareRoute mounts the LiveKit token endpoint.
func RegisterScreenshareRoute(rg *gin.RouterGroup, store *room.Store, cfg config.Config, authorizer memberAuthorizer) {
	rg.POST("/rooms/:id/screenshare/token", createScreenshareToken(store, cfg, authorizer))
}

func createScreenshareToken(store *room.Store, cfg config.Config, authorizer memberAuthorizer) gin.HandlerFunc {
	return func(c *gin.Context) {
		if cfg.LivekitURL == "" || cfg.LivekitAPIKey == "" || cfg.LivekitAPISecret == "" {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "screenshare_disabled"})
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxScreenshareBodyBytes)
		var request screenshareTokenRequest
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

		canPublish := true
		canSubscribe := true
		token, err := auth.NewAccessToken(cfg.LivekitAPIKey, cfg.LivekitAPISecret).
			SetVideoGrant(&auth.VideoGrant{
				RoomJoin: true, Room: roomID,
				CanPublish: &canPublish, CanSubscribe: &canSubscribe,
			}).
			SetIdentity(request.MemberID).
			SetValidFor(2 * time.Hour).
			ToJWT()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"token": token, "url": cfg.LivekitURL})
	}
}

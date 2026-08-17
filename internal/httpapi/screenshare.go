package httpapi

import (
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/livekit/protocol/auth"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
)

const maxScreenshareBodyBytes = 4 << 10

type screenshareTokenRequest struct {
	Nickname string `json:"nickname" binding:"required"`
}

// RegisterScreenshareRoute mounts the LiveKit token endpoint.
func RegisterScreenshareRoute(rg *gin.RouterGroup, store *room.Store, cfg config.Config) {
	rg.POST("/rooms/:id/screenshare/token", createScreenshareToken(store, cfg))
}

func createScreenshareToken(store *room.Store, cfg config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		if cfg.LivekitURL == "" || cfg.LivekitAPIKey == "" || cfg.LivekitAPISecret == "" {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "screenshare_disabled"})
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxScreenshareBodyBytes)
		var request screenshareTokenRequest
		if err := c.ShouldBindJSON(&request); err != nil || !validDisplayName(request.Nickname) {
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
		members, err := store.Members(c.Request.Context(), roomID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
			return
		}
		slices.SortFunc(members, func(a, b room.Member) int {
			if a.JoinedAt.Before(b.JoinedAt) {
				return -1
			}
			if a.JoinedAt.After(b.JoinedAt) {
				return 1
			}
			return strings.Compare(a.ID, b.ID)
		})
		var identity string
		for _, member := range members {
			if member.Nickname == request.Nickname {
				identity = member.ID
				break
			}
		}
		if identity == "" {
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
			SetIdentity(identity).
			SetValidFor(2 * time.Hour).
			ToJWT()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"token": token, "url": cfg.LivekitURL})
	}
}

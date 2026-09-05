package httpapi

import (
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
)

const maxScreenshareBodyBytes = 4 << 10

type screenshareRequest struct {
	MemberID   string `json:"memberId" binding:"required"`
	Capability string `json:"capability" binding:"required"`
	Live       *bool  `json:"live"`
}

type memberAuthorizer interface {
	AuthorizeMember(roomID, memberID, capability string) bool
}

// RegisterScreenshareRoutes mounts the MoQ relay handout and the "host is
// publishing" flag. The relay is shared by every room and hands out a fixed
// pair of tokens, so the server's job is to give each member the token their
// role allows and the broadcast path only this room knows.
func RegisterScreenshareRoutes(rg *gin.RouterGroup, store *room.Store, cfg config.Config, authorizer memberAuthorizer, notify func(roomID string)) {
	rg.POST("/rooms/:id/screenshare/token", screenshareRelay(store, cfg, authorizer))
	rg.POST("/rooms/:id/screenshare/live", screenshareLive(store, authorizer, notify))
}

// ScreenBroadcastPath is where a room's screen lives on the relay: the room id
// keeps paths apart, the secret keeps them unguessable, and the suffix tells
// the player which catalog format to expect.
func ScreenBroadcastPath(roomID, secret string) string {
	return "juntos/" + roomID + "/" + secret + ".hang"
}

func screenshareMember(c *gin.Context, store *room.Store, authorizer memberAuthorizer) (*room.Room, screenshareRequest, bool) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxScreenshareBodyBytes)
	var request screenshareRequest
	if err := c.ShouldBindJSON(&request); err != nil || request.MemberID == "" || request.Capability == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return nil, request, false
	}
	roomID := c.Param("id")
	storedRoom, err := store.Get(c.Request.Context(), roomID)
	if errors.Is(err, room.ErrNotFound) || err == nil && !storedRoom.ExpiresAt.After(time.Now()) {
		c.JSON(http.StatusNotFound, gin.H{"error": "room_not_found"})
		return nil, request, false
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
		return nil, request, false
	}
	if authorizer == nil || !authorizer.AuthorizeMember(roomID, request.MemberID, request.Capability) {
		c.JSON(http.StatusForbidden, gin.H{"error": "member_not_found"})
		return nil, request, false
	}
	return storedRoom, request, true
}

func screenshareRelay(store *room.Store, cfg config.Config, authorizer memberAuthorizer) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !cfg.ScreenshareEnabled() {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "screenshare_disabled"})
			return
		}
		storedRoom, request, ok := screenshareMember(c, store, authorizer)
		if !ok {
			return
		}
		secret, err := store.ScreenSecret(c.Request.Context(), storedRoom.ID)
		if errors.Is(err, room.ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "room_not_found"})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
			return
		}
		token := cfg.MoqSubscribeToken
		publish := storedRoom.ControllerID == request.MemberID
		if publish {
			token = cfg.MoqPublishToken
		}
		c.JSON(http.StatusOK, gin.H{
			"url":     cfg.MoqRelayURL + "/" + token,
			"path":    ScreenBroadcastPath(storedRoom.ID, secret),
			"publish": publish,
		})
	}
}

func screenshareLive(store *room.Store, authorizer memberAuthorizer, notify func(roomID string)) gin.HandlerFunc {
	return func(c *gin.Context) {
		storedRoom, request, ok := screenshareMember(c, store, authorizer)
		if !ok {
			return
		}
		if request.Live == nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		if storedRoom.ControllerID != request.MemberID {
			c.JSON(http.StatusForbidden, gin.H{"error": "not_controller"})
			return
		}
		if err := store.SetScreenLive(c.Request.Context(), storedRoom.ID, *request.Live); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
			return
		}
		if notify != nil {
			notify(storedRoom.ID)
		}
		c.JSON(http.StatusOK, gin.H{"live": *request.Live})
	}
}

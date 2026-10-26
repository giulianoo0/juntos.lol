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
	// Publish asks for the publish token; without it every member gets the
	// subscribe one, so the token that lets anyone write only reaches the
	// browsers about to write.
	Publish bool `json:"publish"`
}

type memberAuthorizer interface {
	AuthorizeMember(roomID, memberID, capability string) bool
}

// RegisterScreenshareRoutes mounts the MoQ relay handout and the "member is
// publishing" flag. The relay is shared by every room and hands out a fixed
// pair of tokens, so the server's job is to give each member the token their
// standing allows — the host, or a guest the host let share — and the
// broadcast path only this room knows.
func RegisterScreenshareRoutes(rg *gin.RouterGroup, store *room.Store, cfg config.Config, authorizer stageAuthorizer, notify func(roomID string)) {
	rg.POST("/rooms/:id/screenshare/token", screenshareRelay(store, cfg, authorizer))
	rg.POST("/rooms/:id/screenshare/live", screenshareLive(store, authorizer, notify))
}

// ScreenBroadcastBase is the prefix every screen of a room shares: the room id
// keeps rooms apart and the secret keeps them unguessable.
func ScreenBroadcastBase(roomID, secret string) string {
	return "juntos/" + roomID + "/" + secret
}

// ScreenBroadcastPath is where one member's screen lives on the relay. Each
// publisher owns a path of their own, so several screens coexist in a room,
// and the suffix tells the player which catalog format to expect.
func ScreenBroadcastPath(roomID, secret, memberID string) string {
	return ScreenBroadcastBase(roomID, secret) + "/" + memberID + ".hang"
}

func screenshareMember(c *gin.Context, store *room.Store, authorizer stageAuthorizer) (*room.Room, screenshareRequest, bool) {
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

func screenshareRelay(store *room.Store, cfg config.Config, authorizer stageAuthorizer) gin.HandlerFunc {
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
		// Asking for the token comes before the screen starts, so it only
		// looks at a grant; starting is what spends it.
		publish := authorizer.AuthorizeStage(storedRoom, request.MemberID, request.Capability, room.StageScreen, false)
		if publish && request.Publish {
			token = cfg.MoqPublishToken
		}
		c.JSON(http.StatusOK, gin.H{
			"url":     cfg.MoqRelayURL + "/" + token,
			"base":    ScreenBroadcastBase(storedRoom.ID, secret),
			"path":    ScreenBroadcastPath(storedRoom.ID, secret, request.MemberID),
			"publish": publish,
			"bridge":  cfg.MoqBridgeURL,
		})
	}
}

func screenshareLive(store *room.Store, authorizer stageAuthorizer, notify func(roomID string)) gin.HandlerFunc {
	return func(c *gin.Context) {
		storedRoom, request, ok := screenshareMember(c, store, authorizer)
		if !ok {
			return
		}
		if request.Live == nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		// Stopping is always allowed: a share the host took away still has
		// to be able to take itself down.
		if *request.Live {
			if !authorizeStage(c, authorizer, storedRoom, request.MemberID, request.Capability, room.StageScreen, true) {
				return
			}
			nickname := ""
			members, err := store.Members(c.Request.Context(), storedRoom.ID)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
				return
			}
			for _, member := range members {
				if member.ID == request.MemberID {
					nickname = member.Nickname
				}
			}
			err = store.StartScreenShare(c.Request.Context(), storedRoom.ID, room.ScreenShare{
				MemberID: request.MemberID, Nickname: nickname, Since: time.Now().UTC(),
			})
			switch {
			case errors.Is(err, room.ErrTooManyScreens):
				c.JSON(http.StatusConflict, gin.H{"error": "too_many_screens"})
				return
			case errors.Is(err, room.ErrNotFound):
				c.JSON(http.StatusNotFound, gin.H{"error": "room_not_found"})
				return
			case err != nil:
				c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
				return
			}
		} else if _, err := store.StopScreenShare(c.Request.Context(), storedRoom.ID, request.MemberID); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
			return
		}
		if notify != nil {
			notify(storedRoom.ID)
		}
		c.JSON(http.StatusOK, gin.H{"live": *request.Live})
	}
}

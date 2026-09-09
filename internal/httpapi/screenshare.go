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
	Open       *bool  `json:"open"`
	// Publish asks for the publish token; without it every member gets the
	// subscribe one, so the token that lets anyone write only reaches the
	// browsers about to write.
	Publish bool `json:"publish"`
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
	rg.POST("/rooms/:id/screenshare/open", screenshareOpen(store, authorizer, notify))
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
		publish := storedRoom.ControllerID == request.MemberID || storedRoom.ScreenShareOpen
		if publish && request.Publish {
			token = cfg.MoqPublishToken
		}
		c.JSON(http.StatusOK, gin.H{
			"url":     cfg.MoqRelayURL + "/" + token,
			"base":    ScreenBroadcastBase(storedRoom.ID, secret),
			"path":    ScreenBroadcastPath(storedRoom.ID, secret, request.MemberID),
			"publish": publish,
			"open":    storedRoom.ScreenShareOpen,
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
		controller := storedRoom.ControllerID == request.MemberID
		// Stopping is always allowed: a share the room closed still has to be
		// able to take itself down.
		if *request.Live {
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
			}, controller)
			switch {
			case errors.Is(err, room.ErrSharingClosed):
				c.JSON(http.StatusForbidden, gin.H{"error": "sharing_closed"})
				return
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

// screenshareOpen is the host's switch for guest sharing. Closing it ends
// every guest share at once; the host's own screen stays up.
func screenshareOpen(store *room.Store, authorizer memberAuthorizer, notify func(roomID string)) gin.HandlerFunc {
	return func(c *gin.Context) {
		storedRoom, request, ok := screenshareMember(c, store, authorizer)
		if !ok {
			return
		}
		if request.Open == nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		if storedRoom.ControllerID != request.MemberID {
			c.JSON(http.StatusForbidden, gin.H{"error": "not_controller"})
			return
		}
		if err := store.SetScreenShareOpen(c.Request.Context(), storedRoom.ID, *request.Open); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
			return
		}
		if !*request.Open {
			if _, err := store.StopScreenSharesExcept(c.Request.Context(), storedRoom.ID, storedRoom.ControllerID); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
				return
			}
		}
		if notify != nil {
			notify(storedRoom.ID)
		}
		c.JSON(http.StatusOK, gin.H{"open": *request.Open})
	}
}

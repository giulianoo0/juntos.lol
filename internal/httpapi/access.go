package httpapi

import (
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/giulianoo0/ss/internal/room"
)

const maxPasswordBytes = 128

// joinAccess reads the door a new room asks for. A password alone means a
// password room; a password room without one is refused. It writes the 400
// itself and reports false when the request is no good.
func joinAccess(c *gin.Context, mode, password string) (room.Access, bool) {
	if mode == "" {
		mode = room.JoinOpen
		if password != "" {
			mode = room.JoinPassword
		}
	}
	if !room.ValidJoinMode(mode) || len(password) > maxPasswordBytes || mode == room.JoinPassword && password == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return room.Access{}, false
	}
	access := room.Access{Mode: mode}
	if mode == room.JoinPassword {
		hash, err := room.HashPassword(password)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
			return room.Access{}, false
		}
		access.PasswordHash = hash
	}
	return access, true
}

// roomCreationLimit refuses an address that has opened too many rooms this
// hour, so a script cannot fill the store; a person never comes close.
func roomCreationLimit(perHour int, behindEdge bool) gin.HandlerFunc {
	limiter := newWindowLimiter(perHour, time.Hour)
	return func(c *gin.Context) {
		if perHour > 0 && !limiter.allow(requestIP(c.Request, behindEdge)) {
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": "too_many_rooms"})
			return
		}
		c.Next()
	}
}

// setRoomAccess is the host changing who gets in. Turning a password on
// needs a password, unless the room already has one from before.
func setRoomAccess(store *room.Store, authorizer memberAuthorizer, notify func(roomID string)) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxJoinBodyBytes)
		var request struct {
			MemberID   string `json:"memberId"`
			Capability string `json:"capability"`
			JoinMode   string `json:"joinMode"`
			Password   string `json:"password"`
		}
		if err := c.ShouldBindJSON(&request); err != nil || request.MemberID == "" || request.Capability == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		roomID := c.Param("id")
		storedRoom, err := store.Get(c.Request.Context(), roomID)
		if errors.Is(err, room.ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "room_not_found"})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
			return
		}
		if authorizer == nil || !authorizer.AuthorizeMember(roomID, request.MemberID, request.Capability) || storedRoom.ControllerID != request.MemberID {
			c.JSON(http.StatusForbidden, gin.H{"error": "not_controller"})
			return
		}
		current, err := store.Access(c.Request.Context(), roomID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
			return
		}
		var next room.Access
		if request.JoinMode == room.JoinPassword && request.Password == "" && current.PasswordHash != "" {
			next = current
		} else {
			var ok bool
			if next, ok = joinAccess(c, request.JoinMode, request.Password); !ok {
				return
			}
		}
		if err := store.SetAccess(c.Request.Context(), roomID, next); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
			return
		}
		if notify != nil {
			notify(roomID)
		}
		c.JSON(http.StatusOK, gin.H{"joinMode": next.Mode})
	}
}

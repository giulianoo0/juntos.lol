package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
)

const maxSourceBodyBytes = 4 << 10

// SourceHooks lets a room change what it is playing without httpapi depending on
// the media pipeline. Both are nil-safe, and CancelMedia runs before the old files
// are removed so ffmpeg is not left writing into a directory being deleted.
type SourceHooks struct {
	CancelMedia  func(roomID string)
	NotifyStatus func(roomID, status string)
}

type changeSourceRequest struct {
	MemberID   string `json:"memberId" binding:"required"`
	Capability string `json:"capability" binding:"required"`
	Kind       string `json:"kind" binding:"required"`
	FileName   string `json:"fileName"`
}

// RegisterSourceRoute mounts the controller-only endpoint that repoints a live room
// at a new source; members, chat and the controller all survive the swap.
func RegisterSourceRoute(rg *gin.RouterGroup, store *room.Store, cfg config.Config,
	authorizer memberAuthorizer, hooks SourceHooks) {
	rg.POST("/rooms/:id/source", changeSource(store, cfg, authorizer, hooks))
}

func changeSource(store *room.Store, cfg config.Config, authorizer memberAuthorizer,
	hooks SourceHooks) gin.HandlerFunc {
	return func(c *gin.Context) {
		roomID := c.Param("id")
		if !validMediaRoomID(roomID) {
			c.Status(http.StatusNotFound)
			return
		}

		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxSourceBodyBytes)
		var req changeSourceRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}

		status, fileName, ok := sourceTarget(req)
		if !ok {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}

		storedRoom, err := store.Get(c.Request.Context(), roomID)
		if errors.Is(err, room.ErrNotFound) || err == nil && !storedRoom.ExpiresAt.After(time.Now()) {
			c.JSON(http.StatusNotFound, gin.H{"error": "room_not_found"})
			return
		}
		if err != nil {
			slog.ErrorContext(c.Request.Context(), "load room for source change", "room_id", roomID, "error", err)
			c.Status(http.StatusInternalServerError)
			return
		}

		if authorizer == nil || !authorizer.AuthorizeMember(roomID, req.MemberID, req.Capability) {
			c.JSON(http.StatusForbidden, gin.H{"error": "member_not_found"})
			return
		}
		if storedRoom.ControllerID != req.MemberID {
			c.JSON(http.StatusForbidden, gin.H{"error": "not_controller"})
			return
		}

		if hooks.CancelMedia != nil {
			hooks.CancelMedia(roomID)
		}
		if err := os.RemoveAll(filepath.Join(cfg.DataDir, "rooms", roomID)); err != nil {
			slog.ErrorContext(c.Request.Context(), "remove previous room media", "room_id", roomID, "error", err)
			c.Status(http.StatusInternalServerError)
			return
		}

		_, generation, err := store.SwapSource(
			c.Request.Context(), roomID, req.Kind, fileName, status, time.Now())
		if errors.Is(err, room.ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "room_not_found"})
			return
		}
		if err != nil {
			slog.ErrorContext(c.Request.Context(), "swap room source", "room_id", roomID, "error", err)
			c.Status(http.StatusInternalServerError)
			return
		}

		if hooks.NotifyStatus != nil {
			hooks.NotifyStatus(roomID, status)
		}
		c.JSON(http.StatusOK, gin.H{
			"status":          status,
			"sourceKind":      req.Kind,
			"fileName":        fileName,
			"mediaGeneration": generation,
		})
	}
}

// sourceTarget validates the requested source and reports the status the room should
// land in: an upload must be prepared first, a shared screen is live immediately.
func sourceTarget(req changeSourceRequest) (status, fileName string, ok bool) {
	switch req.Kind {
	case room.SourceUpload:
		if !validFileName(req.FileName) {
			return "", "", false
		}
		return "uploading", req.FileName, true
	case room.SourceScreen:
		return "ready", "", true
	default:
		return "", "", false
	}
}

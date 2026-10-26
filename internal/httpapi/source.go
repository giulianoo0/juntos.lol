package httpapi

import (
	"context"
	"crypto/subtle"
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

// SourceHooks lets a room change what its stages play without httpapi
// depending on the media pipeline. All are nil-safe. CancelMedia stops the
// media's production and runs before the old files are removed, so ffmpeg is
// not left writing into a directory being deleted; CancelLive stops the live's
// producer and nothing else. ResetPlayback runs once the room points at the
// new source, before its status is announced, so members drop the old clock
// before they look for new media. NotifyRoomUpdated tells members to refetch
// the room, for changes that are not the media's status.
type SourceHooks struct {
	CancelMedia       func(roomID string)
	CancelLive        func(roomID string)
	NotifyStatus      func(roomID, status string)
	NotifyRoomUpdated func(roomID string)
	ResetPlayback     func(roomID string)
}

// changeSourceRequest is a member's seat, or the creator's ownerToken while
// the room has not seated them yet. Kind is upload or youtube: a YouTube
// title may carry a slash a file name may not.
type changeSourceRequest struct {
	MemberID   string `json:"memberId"`
	Capability string `json:"capability"`
	OwnerToken string `json:"ownerToken"`
	Kind       string `json:"kind" binding:"required"`
	FileName   string `json:"fileName"`
}

// RegisterSourceRoute mounts the endpoint that repoints the room's media
// stage at a new source; members, chat, controller, screens and live all
// survive the swap.
func RegisterSourceRoute(rg *gin.RouterGroup, store *room.Store, cfg config.Config,
	authorizer stageAuthorizer, hooks SourceHooks) {
	rg.POST("/rooms/:id/source", changeSource(store, cfg, authorizer, hooks))
}

func changeSource(store *room.Store, cfg config.Config, authorizer stageAuthorizer,
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

		holder := req.MemberID
		if req.OwnerToken != "" {
			if storedRoom.OwnerToken == "" || subtle.ConstantTimeCompare([]byte(req.OwnerToken), []byte(storedRoom.OwnerToken)) != 1 {
				c.JSON(http.StatusForbidden, gin.H{"error": "not_owner"})
				return
			}
			holder = storedRoom.ControllerID
		} else if !authorizeStage(c, authorizer, storedRoom, req.MemberID, req.Capability, room.StageMedia, true) {
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
			c.Request.Context(), roomID, holder, fileName, status, time.Now())
		if errors.Is(err, room.ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "room_not_found"})
			return
		}
		if err != nil {
			slog.ErrorContext(c.Request.Context(), "swap room source", "room_id", roomID, "error", err)
			c.Status(http.StatusInternalServerError)
			return
		}

		if hooks.ResetPlayback != nil {
			hooks.ResetPlayback(roomID)
		}
		if hooks.NotifyStatus != nil {
			hooks.NotifyStatus(roomID, status)
		}
		c.JSON(http.StatusOK, gin.H{
			"status":          status,
			"fileName":        fileName,
			"mediaGeneration": generation,
		})
	}
}

// CloseStage takes the media or the live down when its owner or the host
// closes it: production stops and the stage empties, and the rest of the
// room plays on. Screens end in the hub, which has nothing to stop.
func CloseStage(ctx context.Context, store *room.Store, cfg config.Config, hooks SourceHooks, roomID, kind string) error {
	switch kind {
	case room.StageMedia:
		if hooks.CancelMedia != nil {
			hooks.CancelMedia(roomID)
		}
		if err := os.RemoveAll(filepath.Join(cfg.DataDir, "rooms", roomID)); err != nil {
			return err
		}
		if _, _, err := store.SwapSource(ctx, roomID, "", "", room.StatusEmpty, time.Now()); err != nil {
			return err
		}
		if hooks.ResetPlayback != nil {
			hooks.ResetPlayback(roomID)
		}
		if hooks.NotifyStatus != nil {
			hooks.NotifyStatus(roomID, room.StatusEmpty)
		}
	case room.StageLive:
		if hooks.CancelLive != nil {
			hooks.CancelLive(roomID)
		}
		if err := store.SetLive(ctx, roomID, nil); err != nil {
			return err
		}
		if hooks.NotifyRoomUpdated != nil {
			hooks.NotifyRoomUpdated(roomID)
		}
	}
	return nil
}

// sourceTarget validates the requested source and reports the status the room
// should land in.
func sourceTarget(req changeSourceRequest) (status, fileName string, ok bool) {
	switch req.Kind {
	case "upload":
		if !validFileName(req.FileName) {
			return "", "", false
		}
		return "uploading", req.FileName, true
	case "youtube":
		if !validRoomText(req.FileName, maxFileNameBytes) {
			return "", "", false
		}
		return "uploading", req.FileName, true
	default:
		return "", "", false
	}
}

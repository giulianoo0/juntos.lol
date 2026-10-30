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
// the room has not seated them yet. Kind is upload, youtube or local: a
// YouTube title may carry a slash a file name may not, and a local source is
// one the host's desktop app plays from its own cache, named by Title.
type changeSourceRequest struct {
	MemberID   string `json:"memberId"`
	Capability string `json:"capability"`
	OwnerToken string `json:"ownerToken"`
	Kind       string `json:"kind" binding:"required"`
	FileName   string `json:"fileName"`
	Title      string `json:"title"`
	DurationMs int64  `json:"durationMs"`
}

// RegisterSourceRoute mounts the endpoints that repoint the room's media
// stage at a new source, and that hand a local source's upload to the app
// holding it; members, chat, controller, screens and live all survive.
func RegisterSourceRoute(rg *gin.RouterGroup, store *room.Store, cfg config.Config,
	authorizer stageAuthorizer, hooks SourceHooks) {
	rg.POST("/rooms/:id/source", changeSource(store, cfg, authorizer, hooks))
	rg.POST("/rooms/:id/local/promote", promoteLocal(store, cfg, authorizer, hooks))
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

		storedRoom, ok := loadLiveRoom(c, store, roomID)
		if !ok {
			return
		}

		holder := req.MemberID
		if req.OwnerToken != "" {
			if storedRoom.OwnerToken == "" || subtle.ConstantTimeCompare([]byte(req.OwnerToken), []byte(storedRoom.OwnerToken)) != 1 {
				c.JSON(http.StatusForbidden, gin.H{"error": "not_owner"})
				return
			}
			holder = storedRoom.ControllerID
		} else if status == room.StatusLocal {
			if !authorizeController(c, authorizer, storedRoom, req.MemberID, req.Capability) {
				return
			}
		} else if !authorizeStage(c, authorizer, storedRoom, req.MemberID, req.Capability, room.StageMedia, true) {
			return
		}

		generation, err := swapMedia(c.Request.Context(), store, cfg, hooks, roomID, holder, fileName, status, localDuration(status, req))
		if errors.Is(err, room.ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "room_not_found"})
			return
		}
		if err != nil {
			slog.ErrorContext(c.Request.Context(), "swap room source", "room_id", roomID, "error", err)
			c.Status(http.StatusInternalServerError)
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"status":          status,
			"fileName":        fileName,
			"mediaGeneration": generation,
		})
	}
}

// swapMedia is every step of putting a new source on the media stage, or
// none, in the order members depend on: production stops before its files
// go, and the clock resets before the status is announced.
func swapMedia(ctx context.Context, store *room.Store, cfg config.Config, hooks SourceHooks,
	roomID, holder, fileName, status string, durationMs int64) (int, error) {
	if hooks.CancelMedia != nil {
		hooks.CancelMedia(roomID)
	}
	if err := os.RemoveAll(filepath.Join(cfg.DataDir, "rooms", roomID)); err != nil {
		return 0, err
	}
	_, generation, err := store.SwapSource(ctx, roomID, holder, fileName, status, time.Now())
	if err != nil {
		return 0, err
	}
	if durationMs > 0 {
		if err := store.SetMediaDuration(ctx, roomID, durationMs); err != nil {
			slog.WarnContext(ctx, "store local source duration", "room_id", roomID, "error", err)
		}
	}
	if hooks.ResetPlayback != nil {
		hooks.ResetPlayback(roomID)
	}
	if hooks.NotifyStatus != nil {
		hooks.NotifyStatus(roomID, status)
	}
	return generation, nil
}

// authorizeController answers the refusal itself and reports whether the
// caller is the room's connected controller.
func authorizeController(c *gin.Context, authorizer stageAuthorizer, storedRoom *room.Room, memberID, capability string) bool {
	if authorizer == nil || !authorizer.AuthorizeMember(storedRoom.ID, memberID, capability) {
		c.JSON(http.StatusForbidden, gin.H{"error": "member_not_found"})
		return false
	}
	if storedRoom.ControllerID != memberID {
		c.JSON(http.StatusForbidden, gin.H{"error": "not_controller"})
		return false
	}
	return true
}

type promoteRequest struct {
	MemberID   string `json:"memberId" binding:"required"`
	Capability string `json:"capability" binding:"required"`
}

// promoteLocal starts the upload of a local source because a browser joined
// that cannot play the app's cache. The room keeps its generation and its
// clock, and the app gets the same claim a browser remux does, to publish
// regions from wherever the room is.
func promoteLocal(store *room.Store, cfg config.Config, authorizer stageAuthorizer, hooks SourceHooks) gin.HandlerFunc {
	return func(c *gin.Context) {
		roomID := c.Param("id")
		if !validMediaRoomID(roomID) {
			c.Status(http.StatusNotFound)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxSourceBodyBytes)
		var req promoteRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		storedRoom, ok := loadLiveRoom(c, store, roomID)
		if !ok || !authorizeController(c, authorizer, storedRoom, req.MemberID, req.Capability) {
			return
		}
		claim, err := mintSecret("client:")
		if err != nil {
			c.Status(http.StatusInternalServerError)
			return
		}
		ctx := c.Request.Context()
		generation, err := store.PromoteLocal(ctx, roomID, claim, time.Now())
		switch {
		case errors.Is(err, room.ErrNotFound):
			c.JSON(http.StatusNotFound, gin.H{"error": "room_not_found"})
			return
		case errors.Is(err, room.ErrUploadNotAllowed):
			c.JSON(http.StatusConflict, gin.H{"error": "not_local"})
			return
		case err != nil:
			slog.ErrorContext(ctx, "promote local source", "room_id", roomID, "error", err)
			c.Status(http.StatusInternalServerError)
			return
		}
		response, ok := claimResponse(c, store, cfg, roomID, claim, generation)
		if !ok {
			return
		}
		if storedRoom.Status == room.StatusLocal && hooks.NotifyStatus != nil {
			hooks.NotifyStatus(roomID, room.StatusUploading)
		}
		c.JSON(http.StatusOK, response)
	}
}

// CloseStage takes the media or the live down when its owner or the host
// closes it: production stops and the stage empties, and the rest of the
// room plays on. Screens end in the hub, which has nothing to stop.
func CloseStage(ctx context.Context, store *room.Store, cfg config.Config, hooks SourceHooks, roomID, kind string) error {
	switch kind {
	case room.StageMedia:
		if _, err := swapMedia(ctx, store, cfg, hooks, roomID, "", "", room.StatusEmpty, 0); err != nil {
			return err
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

// localDuration is the length the app read from its file; the other kinds
// learn theirs from the producer.
func localDuration(status string, req changeSourceRequest) int64 {
	if status != room.StatusLocal {
		return 0
	}
	return req.DurationMs
}

// sourceTarget validates the requested source and reports the status the room
// should land in.
func sourceTarget(req changeSourceRequest) (status, fileName string, ok bool) {
	switch req.Kind {
	case "upload":
		if !validFileName(req.FileName) {
			return "", "", false
		}
		return room.StatusUploading, req.FileName, true
	case "youtube":
		if !validRoomText(req.FileName, maxFileNameBytes) {
			return "", "", false
		}
		return room.StatusUploading, req.FileName, true
	case "local":
		if !validRoomText(req.Title, maxFileNameBytes) || req.DurationMs < 0 {
			return "", "", false
		}
		return room.StatusLocal, req.Title, true
	default:
		return "", "", false
	}
}

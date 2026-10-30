package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/remux"
	"github.com/giulianoo0/ss/internal/room"
	"github.com/giulianoo0/ss/internal/worker"
)

// A live is a YouTube stream put on the MoQ relay by a producer: a worker
// of the fleet, or the companion app of whoever opened it. It is a stage of
// its own beside the media (no timeline, no seek), and its status follows
// the producer's word.

const (
	LiveProducerFleet  = "fleet"
	LiveProducerJlocal = "jlocal"
	liveBroadcastName  = "live.hang"
	maxLiveBodyBytes   = 8 << 10
)

// LiveBroadcastPath is where a room's live sits on the relay, next to the
// screens the room's members may share.
func LiveBroadcastPath(roomID, secret string) string {
	return ScreenBroadcastBase(roomID, secret) + "/" + liveBroadcastName
}

type liveStartRequest struct {
	MemberID   string `json:"memberId" binding:"required"`
	Capability string `json:"capability" binding:"required"`
	URL        string `json:"url" binding:"required"`
	Producer   string `json:"producer" binding:"required"`
	Title      string `json:"title"`
	Thumbnail  string `json:"thumbnail"`
}

type liveStateRequest struct {
	MemberID   string `json:"memberId" binding:"required"`
	Capability string `json:"capability" binding:"required"`
	State      string `json:"state" binding:"required"`
	Code       string `json:"code"`
	Detail     string `json:"detail"`
}

// RegisterLiveRoutes mounts the live start and the companion app's state
// report. service may be nil: then only the companion app can produce.
func RegisterLiveRoutes(rg *gin.RouterGroup, store *room.Store, cfg config.Config, authorizer stageAuthorizer,
	hooks SourceHooks, service *worker.Service) {
	rg.POST("/rooms/:id/live", startLive(store, cfg, authorizer, hooks, service))
	rg.POST("/rooms/:id/live/state", reportLive(store, authorizer, hooks.NotifyRoomUpdated))
}

func loadLiveStageRoom(c *gin.Context, store *room.Store) (*room.Room, bool) {
	roomID := c.Param("id")
	if !validMediaRoomID(roomID) {
		c.JSON(http.StatusNotFound, gin.H{"error": "room_not_found"})
		return nil, false
	}
	storedRoom, err := store.Get(c.Request.Context(), roomID)
	if errors.Is(err, room.ErrNotFound) || err == nil && !storedRoom.ExpiresAt.After(time.Now()) {
		c.JSON(http.StatusNotFound, gin.H{"error": "room_not_found"})
		return nil, false
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
		return nil, false
	}
	return storedRoom, true
}

func startLive(store *room.Store, cfg config.Config, authorizer stageAuthorizer, hooks SourceHooks, service *worker.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !cfg.ScreenshareEnabled() {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "live_disabled"})
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxLiveBodyBytes)
		var req liveStartRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		videoID, ok := YoutubeVideoID(req.URL)
		if !ok || (req.Producer != LiveProducerFleet && req.Producer != LiveProducerJlocal) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		if req.Title == "" || !validRoomText(req.Title, maxFileNameBytes) {
			req.Title = "YouTube live"
		}
		if req.Producer == LiveProducerFleet && service == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "youtube_no_workers"})
			return
		}
		storedRoom, ok := loadLiveStageRoom(c, store)
		if !ok || !authorizeStage(c, authorizer, storedRoom, req.MemberID, req.Capability, room.StageLive, true) {
			return
		}
		ctx := c.Request.Context()
		secret, err := store.ScreenSecret(ctx, storedRoom.ID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
			return
		}
		// One live per room: the one on now gives way; the media and the
		// screens stay.
		if hooks.CancelLive != nil {
			hooks.CancelLive(storedRoom.ID)
		}
		live := &room.LiveInfo{
			VideoID:   videoID,
			Title:     req.Title,
			Thumbnail: req.Thumbnail,
			Producer:  req.Producer,
			Broadcast: LiveBroadcastPath(storedRoom.ID, secret),
			MemberID:  req.MemberID,
			Status:    "processing",
		}
		if req.Producer == LiveProducerFleet {
			job, err := service.StartLive(ctx, storedRoom.ID, CanonicalYoutubeURL(videoID), cfg.MoqRelayURL+"/"+cfg.MoqPublishToken, live.Broadcast)
			if err != nil {
				code := liveStartCode(err)
				live.Status, live.Error = "error", code
				if err := store.SetLive(ctx, storedRoom.ID, live); err != nil {
					slog.ErrorContext(ctx, "record failed live", "room_id", storedRoom.ID, "error", err)
				}
				if hooks.NotifyRoomUpdated != nil {
					hooks.NotifyRoomUpdated(storedRoom.ID)
				}
				c.JSON(http.StatusServiceUnavailable, gin.H{"error": code})
				return
			}
			live.WorkerID, live.JobID = job.WorkerID, job.ID
		}
		if err := store.SetLive(ctx, storedRoom.ID, live); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
			return
		}
		if hooks.NotifyRoomUpdated != nil {
			hooks.NotifyRoomUpdated(storedRoom.ID)
		}
		c.JSON(http.StatusOK, gin.H{
			"status":    live.Status,
			"broadcast": live.Broadcast,
		})
	}
}

func liveStartCode(err error) string {
	switch {
	case errors.Is(err, worker.ErrWorkersBusy):
		return "youtube_busy"
	case errors.Is(err, worker.ErrNoLive), errors.Is(err, worker.ErrNoYoutube), errors.Is(err, worker.ErrDisabled):
		return "youtube_no_workers"
	}
	code := err.Error()
	if code == "" {
		return "youtube_tool"
	}
	return code
}

// reportLive is the companion app's producer speaking through the tab of
// whoever opened the live: it is on, over, or lost.
func reportLive(store *room.Store, authorizer stageAuthorizer, notify func(roomID string)) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxLiveBodyBytes)
		var req liveStateRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		storedRoom, ok := loadLiveStageRoom(c, store)
		if !ok {
			return
		}
		if authorizer == nil || !authorizer.AuthorizeMember(storedRoom.ID, req.MemberID, req.Capability) {
			c.JSON(http.StatusForbidden, gin.H{"error": "member_not_found"})
			return
		}
		if storedRoom.Live == nil || storedRoom.Live.Producer != LiveProducerJlocal {
			c.JSON(http.StatusConflict, gin.H{"error": "not_live"})
			return
		}
		if storedRoom.ControllerID != req.MemberID && storedRoom.Live.MemberID != req.MemberID {
			c.JSON(http.StatusForbidden, gin.H{"error": "not_stage_owner"})
			return
		}
		applyLiveState(c.Request.Context(), store, notify, storedRoom, remux.LiveState{State: req.State, Code: req.Code, Detail: req.Detail})
		c.JSON(http.StatusOK, gin.H{"status": req.State})
	}
}

// applyLiveState moves the live with its producer: on is ready, and the end
// or a failure is an error its owner can act on by picking again.
func applyLiveState(ctx context.Context, store *room.Store, notify func(roomID string), storedRoom *room.Room, state remux.LiveState) {
	live := *storedRoom.Live
	switch state.State {
	case "live":
		if live.Status == "ready" {
			return
		}
		live.Status, live.Error = "ready", ""
	case "ended":
		if live.Status == "error" {
			return
		}
		live.Status, live.Error = "error", "live_ended"
	case "failed":
		if live.Status == "error" {
			return
		}
		code := state.Code
		if code == "" {
			code = "youtube_tool"
		}
		slog.Info("live failed", "room_id", storedRoom.ID, "code", code, "detail", state.Detail)
		live.Status, live.Error = "error", code
	default:
		return
	}
	if err := store.SetLive(ctx, storedRoom.ID, &live); err != nil {
		return
	}
	if notify != nil {
		notify(storedRoom.ID)
	}
}

// LiveReporter turns a worker's live reports into the live's status,
// ignoring a worker that is not the room's producer of record.
func LiveReporter(store *room.Store, notify func(roomID string)) func(roomID, workerID string, state remux.LiveState) {
	return func(roomID, workerID string, state remux.LiveState) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		storedRoom, err := store.Get(ctx, roomID)
		if err != nil || storedRoom.Live == nil {
			return
		}
		if storedRoom.Live.Producer != LiveProducerFleet || storedRoom.Live.WorkerID != workerID {
			return
		}
		applyLiveState(ctx, store, notify, storedRoom, state)
	}
}

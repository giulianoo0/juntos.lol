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
// of the fleet, or the host's companion app. The room turns into a live
// room (no timeline, no seek) and its status follows the producer's word.

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
func RegisterLiveRoutes(rg *gin.RouterGroup, store *room.Store, cfg config.Config, authorizer memberAuthorizer,
	hooks SourceHooks, service *worker.Service) {
	rg.POST("/rooms/:id/live", startLive(store, cfg, authorizer, hooks, service))
	rg.POST("/rooms/:id/live/state", reportLive(store, authorizer, hooks.NotifyStatus))
}

func liveController(c *gin.Context, store *room.Store, authorizer memberAuthorizer, memberID, capability string) (*room.Room, bool) {
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
	if authorizer == nil || !authorizer.AuthorizeMember(roomID, memberID, capability) {
		c.JSON(http.StatusForbidden, gin.H{"error": "member_not_found"})
		return nil, false
	}
	if storedRoom.ControllerID != memberID {
		c.JSON(http.StatusForbidden, gin.H{"error": "not_controller"})
		return nil, false
	}
	return storedRoom, true
}

func startLive(store *room.Store, cfg config.Config, authorizer memberAuthorizer, hooks SourceHooks, service *worker.Service) gin.HandlerFunc {
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
		storedRoom, ok := liveController(c, store, authorizer, req.MemberID, req.Capability)
		if !ok {
			return
		}
		ctx := c.Request.Context()
		secret, err := store.ScreenSecret(ctx, storedRoom.ID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
			return
		}
		if hooks.CancelMedia != nil {
			hooks.CancelMedia(storedRoom.ID)
		}
		_, generation, err := store.SwapSource(ctx, storedRoom.ID, room.SourceLive, req.Title, "processing", time.Now())
		if err != nil {
			slog.ErrorContext(ctx, "swap room to live", "room_id", storedRoom.ID, "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
			return
		}
		if hooks.ResetPlayback != nil {
			hooks.ResetPlayback(storedRoom.ID)
		}
		live := &room.LiveInfo{
			VideoID:   videoID,
			Title:     req.Title,
			Thumbnail: req.Thumbnail,
			Producer:  req.Producer,
			Broadcast: LiveBroadcastPath(storedRoom.ID, secret),
		}
		if req.Producer == LiveProducerFleet {
			job, err := service.StartLive(ctx, storedRoom.ID, CanonicalYoutubeURL(videoID), cfg.MoqRelayURL+"/"+cfg.MoqPublishToken, live.Broadcast)
			if err != nil {
				code := liveStartCode(err)
				_ = store.SetError(ctx, storedRoom.ID, code)
				if hooks.NotifyStatus != nil {
					hooks.NotifyStatus(storedRoom.ID, "error")
				}
				c.JSON(http.StatusServiceUnavailable, gin.H{"error": code, "mediaGeneration": generation})
				return
			}
			live.WorkerID, live.JobID = job.WorkerID, job.ID
		}
		if err := store.SetLive(ctx, storedRoom.ID, live); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
			return
		}
		if hooks.NotifyStatus != nil {
			hooks.NotifyStatus(storedRoom.ID, "processing")
		}
		c.JSON(http.StatusOK, gin.H{
			"status":          "processing",
			"sourceKind":      room.SourceLive,
			"mediaGeneration": generation,
			"broadcast":       live.Broadcast,
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

// reportLive is the companion app's producer speaking through the host's
// tab: the live is on, over, or lost.
func reportLive(store *room.Store, authorizer memberAuthorizer, notify func(roomID, status string)) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxLiveBodyBytes)
		var req liveStateRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		storedRoom, ok := liveController(c, store, authorizer, req.MemberID, req.Capability)
		if !ok {
			return
		}
		if storedRoom.SourceKind != room.SourceLive || storedRoom.Live == nil || storedRoom.Live.Producer != LiveProducerJlocal {
			c.JSON(http.StatusConflict, gin.H{"error": "not_live"})
			return
		}
		applyLiveState(c.Request.Context(), store, notify, storedRoom, remux.LiveState{State: req.State, Code: req.Code, Detail: req.Detail})
		c.JSON(http.StatusOK, gin.H{"status": req.State})
	}
}

// applyLiveState moves the room with its producer: live is ready, and the
// end or a failure is an error the host can act on by picking again.
func applyLiveState(ctx context.Context, store *room.Store, notify func(roomID, status string), storedRoom *room.Room, state remux.LiveState) {
	var status string
	switch state.State {
	case "live":
		if storedRoom.Status == "ready" {
			return
		}
		status = "ready"
		if err := store.SetStatus(ctx, storedRoom.ID, status); err != nil {
			return
		}
	case "ended":
		if storedRoom.Status == "error" {
			return
		}
		status = "error"
		if err := store.SetError(ctx, storedRoom.ID, "live_ended"); err != nil {
			return
		}
	case "failed":
		if storedRoom.Status == "error" {
			return
		}
		status = "error"
		code := state.Code
		if code == "" {
			code = "youtube_tool"
		}
		slog.Info("live failed", "room_id", storedRoom.ID, "code", code, "detail", state.Detail)
		if err := store.SetError(ctx, storedRoom.ID, code); err != nil {
			return
		}
	default:
		return
	}
	if notify != nil {
		notify(storedRoom.ID, status)
	}
}

// LiveReporter turns a worker's live reports into room status, ignoring a
// worker that is not the room's producer of record.
func LiveReporter(store *room.Store, notify func(roomID, status string)) func(roomID, workerID string, state remux.LiveState) {
	return func(roomID, workerID string, state remux.LiveState) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		storedRoom, err := store.Get(ctx, roomID)
		if err != nil || storedRoom.SourceKind != room.SourceLive || storedRoom.Live == nil {
			return
		}
		if storedRoom.Live.Producer != LiveProducerFleet || storedRoom.Live.WorkerID != workerID {
			return
		}
		applyLiveState(ctx, store, notify, storedRoom, state)
	}
}

package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
	"github.com/giulianoo0/ss/internal/urlingest"
)

const maxURLBodyBytes = 4 << 10

// URLIngestor is the piece of the ingest the API needs: hand it a url and it
// pulls the bytes in on its own.
type URLIngestor interface {
	Enabled() bool
	Submit(job urlingest.Job) error
}

type ingestURLRequest struct {
	URL      string `json:"url" binding:"required"`
	FileName string `json:"fileName" binding:"required"`
	// No `binding:"required"` on Size: zero is a legitimate value meaning "the
	// stream did not say", and the ingestor asks the origin instead.
	// `required` on an int64 rejects zero, which would refuse the common case.
	Size int64 `json:"size"`
}

// RegisterURLSourceRoute mounts the endpoint that hands a plugin-supplied url
// to the server-side ingest.
//
// It is guarded exactly like the torrent route it sits next to, and for the
// same reason: this is a request for the server to perform the upload the
// browser would otherwise perform itself. What it adds is the address check —
// the url came from a plugin, so it is the least trusted input the server
// takes, and it is checked before the room is touched at all.
func RegisterURLSourceRoute(rg *gin.RouterGroup, store *room.Store, cfg config.Config, ingestor URLIngestor) {
	if ingestor == nil || !ingestor.Enabled() {
		return
	}
	rg.POST("/rooms/:id/url", ingestURL(store, cfg, ingestor))
}

func ingestURL(store *room.Store, cfg config.Config, ingestor URLIngestor) gin.HandlerFunc {
	return func(c *gin.Context) {
		roomID := c.Param("id")
		if !validMediaRoomID(roomID) {
			c.Status(http.StatusNotFound)
			return
		}

		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxURLBodyBytes)
		var req ingestURLRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		if !validFileName(req.FileName) || req.Size < 0 || req.Size > cfg.MaxUploadMB<<20 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		// The reason travels back because the person who has to act on it is
		// the one who installed the plugin: "not https" and "points at a
		// private address" are different problems with different fixes.
		if _, err := urlingest.CheckURL(req.URL); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "unsafe_source", "reason": err.Error()})
			return
		}

		storedRoom, err := store.Get(c.Request.Context(), roomID)
		if errors.Is(err, room.ErrNotFound) || err == nil && !storedRoom.ExpiresAt.After(time.Now()) {
			c.JSON(http.StatusNotFound, gin.H{"error": "room_not_found"})
			return
		}
		if err != nil {
			slog.ErrorContext(c.Request.Context(), "load room for url ingest", "room_id", roomID, "error", err)
			c.Status(http.StatusInternalServerError)
			return
		}
		if storedRoom.Status != "uploading" {
			c.JSON(http.StatusForbidden, gin.H{"error": "room is not accepting uploads"})
			return
		}
		uploadID, err := store.UploadID(c.Request.Context(), roomID)
		if err != nil {
			slog.ErrorContext(c.Request.Context(), "read upload reservation", "room_id", roomID, "error", err)
			c.Status(http.StatusInternalServerError)
			return
		}
		if uploadID != "" {
			c.JSON(http.StatusConflict, gin.H{"error": "room already has an upload"})
			return
		}

		// A zero here is honest: the room shows a transfer with no total until
		// the ingestor learns one from the origin.
		if err := store.SetIngestProgress(c.Request.Context(), roomID, 0, req.Size); err != nil {
			slog.ErrorContext(c.Request.Context(), "record ingest size", "room_id", roomID, "error", err)
		}
		if err := store.SetPreviewPhase(c.Request.Context(), roomID, room.PreviewReceiving, 0); err != nil {
			slog.ErrorContext(c.Request.Context(), "record preview phase", "room_id", roomID, "error", err)
		}

		err = ingestor.Submit(urlingest.Job{
			RoomID:   roomID,
			URL:      req.URL,
			FileName: req.FileName,
			Size:     req.Size,
		})
		if errors.Is(err, urlingest.ErrBusy) {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "url ingest busy"})
			return
		}
		if err != nil {
			slog.ErrorContext(c.Request.Context(), "submit url ingest", "room_id", roomID, "error", err)
			c.Status(http.StatusInternalServerError)
			return
		}
		c.JSON(http.StatusAccepted, gin.H{"status": "uploading", "sourceBytes": req.Size})
	}
}

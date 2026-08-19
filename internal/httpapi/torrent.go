package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
	"github.com/giulianoo0/ss/internal/torrent"
)

const (
	maxTorrentBodyBytes   = 4 << 10
	maxTorrentPathBytes   = 4 << 10
	maxBridgeSessionBytes = 64
)

// TorrentIngestor is the piece of the ingest the API needs: hand it a file and
// it pulls the bytes in on its own.
type TorrentIngestor interface {
	Enabled() bool
	Submit(job torrent.Job) error
}

type ingestTorrentRequest struct {
	SessionID string `json:"sessionId" binding:"required"`
	Path      string `json:"path" binding:"required"`
	FileName  string `json:"fileName" binding:"required"`
	Size      int64  `json:"size" binding:"required"`
}

// RegisterTorrentRoute mounts the endpoint that hands a chosen torrent file to
// the server-side ingest.
//
// It is guarded exactly like the tus endpoint it feeds — the room must be
// waiting for a source and must not already have one in flight — because that
// is precisely what it is: a request for this server to perform the upload
// that the browser would otherwise perform itself.
func RegisterTorrentRoute(rg *gin.RouterGroup, store *room.Store, cfg config.Config, ingestor TorrentIngestor) {
	if ingestor == nil || !ingestor.Enabled() {
		return
	}
	rg.POST("/rooms/:id/torrent", ingestTorrent(store, cfg, ingestor))
}

func ingestTorrent(store *room.Store, cfg config.Config, ingestor TorrentIngestor) gin.HandlerFunc {
	return func(c *gin.Context) {
		roomID := c.Param("id")
		if !validMediaRoomID(roomID) {
			c.Status(http.StatusNotFound)
			return
		}

		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxTorrentBodyBytes)
		var req ingestTorrentRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		if !validBridgeSession(req.SessionID) || !validTorrentPath(req.Path) ||
			!validFileName(req.FileName) || req.Size <= 0 || req.Size > cfg.MaxUploadMB<<20 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}

		storedRoom, err := store.Get(c.Request.Context(), roomID)
		if errors.Is(err, room.ErrNotFound) || err == nil && !storedRoom.ExpiresAt.After(time.Now()) {
			c.JSON(http.StatusNotFound, gin.H{"error": "room_not_found"})
			return
		}
		if err != nil {
			slog.ErrorContext(c.Request.Context(), "load room for torrent ingest", "room_id", roomID, "error", err)
			c.Status(http.StatusInternalServerError)
			return
		}
		if storedRoom.Status != "uploading" {
			c.JSON(http.StatusForbidden, gin.H{"error": "room is not accepting uploads"})
			return
		}
		// The reservation is what tus itself would refuse a second upload on;
		// checking it here turns that race into a clean answer instead of an
		// ingest that starts and immediately fails.
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

		if err := store.SetIngestProgress(c.Request.Context(), roomID, 0, req.Size); err != nil {
			slog.ErrorContext(c.Request.Context(), "record ingest size", "room_id", roomID, "error", err)
		}
		if err := store.SetPreviewPhase(c.Request.Context(), roomID, room.PreviewReceiving, 0); err != nil {
			slog.ErrorContext(c.Request.Context(), "record preview phase", "room_id", roomID, "error", err)
		}

		err = ingestor.Submit(torrent.Job{
			RoomID:    roomID,
			SessionID: req.SessionID,
			Path:      req.Path,
			FileName:  req.FileName,
			Size:      req.Size,
		})
		if errors.Is(err, torrent.ErrBusy) {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "torrent ingest busy"})
			return
		}
		if err != nil {
			slog.ErrorContext(c.Request.Context(), "submit torrent ingest", "room_id", roomID, "error", err)
			c.Status(http.StatusInternalServerError)
			return
		}
		c.JSON(http.StatusAccepted, gin.H{"status": "uploading", "sourceBytes": req.Size})
	}
}

func validBridgeSession(value string) bool {
	if value == "" || len(value) > maxBridgeSessionBytes {
		return false
	}
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' {
			continue
		}
		return false
	}
	return true
}

// validTorrentPath accepts the path as the bridge reported it. The bridge
// matches it against its own file list, so this only has to reject values that
// could not have come from there.
func validTorrentPath(value string) bool {
	return value != "" && len(value) <= maxTorrentPathBytes &&
		!strings.ContainsRune(value, 0) && strings.TrimSpace(value) != ""
}

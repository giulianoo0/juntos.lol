package httpapi

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
)

const (
	maxSubtitlesBodyBytes = 8 << 20
	maxSubtitleTracks     = 32
	maxSubtitleVTTBytes   = 4 << 20
	maxSubtitleTitleBytes = 255
)

type clientSubtitleTrack struct {
	Language string `json:"language"`
	Title    string `json:"title"`
	VTT      string `json:"vtt"`
}

// Complete distinguishes a finished extraction from a progressive one. A
// torrent or upload still streaming publishes the cues it already has with
// complete=false, which keeps the authoritative ffmpeg pass scheduled. A
// missing field means complete, which is what older clients send.
// MediaGeneration names the source the tracks were read from. A browser
// extraction runs for as long as the file is large, so it can outlive the
// source it started on: the controller swaps the room onto another video and
// the old extraction lands afterwards. Without this the room would be handed
// the previous video's subtitles and, because that also marks the room as
// carrying client subtitles, the server would skip its own extraction and the
// new video would never get the right ones. A missing field means the client
// cannot say, which is what older clients send.
type clientSubtitlesRequest struct {
	Tracks          []clientSubtitleTrack `json:"tracks"`
	Complete        *bool                 `json:"complete"`
	MediaGeneration *int                  `json:"mediaGeneration"`
}

// staleGeneration reports whether these tracks describe a source the room has
// already replaced.
func (r clientSubtitlesRequest) staleGeneration(current int) bool {
	return r.MediaGeneration != nil && *r.MediaGeneration != current
}

func (r clientSubtitlesRequest) complete() bool {
	return r.Complete == nil || *r.Complete
}

// SubtitlePublisher copies a room's subtitle files to the bucket viewers read
// them from. It is an interface here so this package keeps depending only on
// what it uses.
type SubtitlePublisher interface {
	PublishSubtitles(ctx context.Context, roomID, subsDir string) error
}

// RegisterSubtitlesRoute mounts the browser-extracted WebVTT upload endpoint.
// onSubsStored fires after the tracks are persisted (nil-safe). Subtitle
// availability is a room update, not a media-status transition.
func RegisterSubtitlesRoute(rg *gin.RouterGroup, store *room.Store, cfg config.Config,
	publisher SubtitlePublisher, onSubsStored func(roomID string)) {
	rg.POST("/rooms/:id/subtitles", storeClientSubtitles(store, cfg, publisher, onSubsStored))
}

func storeClientSubtitles(store *room.Store, cfg config.Config, publisher SubtitlePublisher,
	onSubsStored func(roomID string)) gin.HandlerFunc {
	return func(c *gin.Context) {
		roomID := c.Param("id")
		if !validMediaRoomID(roomID) {
			c.Status(http.StatusNotFound)
			return
		}
		storedRoom, err := store.Get(c.Request.Context(), roomID)
		if errors.Is(err, room.ErrNotFound) {
			c.Status(http.StatusNotFound)
			return
		}
		if err != nil {
			slog.ErrorContext(c.Request.Context(), "load room for subtitles failed", "room_id", roomID, "error", err)
			c.Status(http.StatusInternalServerError)
			return
		}
		if !storedRoom.ExpiresAt.After(time.Now()) {
			c.Status(http.StatusNotFound)
			return
		}

		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxSubtitlesBodyBytes)
		var req clientSubtitlesRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		if len(req.Tracks) == 0 || len(req.Tracks) > maxSubtitleTracks {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		if req.staleGeneration(storedRoom.MediaGeneration) {
			slog.InfoContext(c.Request.Context(), "discarded subtitles from a replaced source",
				"room_id", roomID, "sent_generation", *req.MediaGeneration,
				"current_generation", storedRoom.MediaGeneration)
			c.JSON(http.StatusConflict, gin.H{"error": "stale_generation"})
			return
		}

		subsDir := filepath.Join(cfg.DataDir, "rooms", roomID, "subs")
		tracks := make([]room.TrackInfo, 0, len(req.Tracks))
		files := make([]string, 0, len(req.Tracks))
		for i, track := range req.Tracks {
			if !validSubtitleTitle(track.Title) || !validSubtitleVTT(track.VTT) {
				c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
				return
			}
			language := sanitizeSubtitleLanguage(track.Language)
			tracks = append(tracks, room.TrackInfo{
				Index:    i,
				Language: language,
				Title:    track.Title,
				Codec:    "webvtt",
			})
			// i and the sanitized language keep the file name path-safe.
			files = append(files, filepath.Join(subsDir, fmt.Sprintf("sub_%d_%s.vtt", i, language)))
		}

		if err := os.MkdirAll(subsDir, 0o755); err != nil {
			slog.ErrorContext(c.Request.Context(), "create subtitles directory failed", "room_id", roomID, "error", err)
			c.Status(http.StatusInternalServerError)
			return
		}
		for i, path := range files {
			if err := os.WriteFile(path, []byte(req.Tracks[i].VTT), 0o644); err != nil {
				slog.ErrorContext(c.Request.Context(), "write subtitle file failed", "room_id", roomID, "error", err)
				c.Status(http.StatusInternalServerError)
				return
			}
		}

		// The bucket gets the files before the tracks are announced: the
		// announcement is what makes a client go and fetch them.
		if publisher != nil {
			if err := publisher.PublishSubtitles(c.Request.Context(), roomID, subsDir); err != nil {
				slog.ErrorContext(c.Request.Context(), "upload client subtitles failed",
					"room_id", roomID, "error", err)
				c.Status(http.StatusInternalServerError)
				return
			}
		}

		if err := store.SetClientSubtitles(c.Request.Context(), roomID, tracks, req.complete()); err != nil {
			if errors.Is(err, room.ErrNotFound) {
				c.Status(http.StatusNotFound)
				return
			}
			slog.ErrorContext(c.Request.Context(), "store client subtitles failed", "room_id", roomID, "error", err)
			c.Status(http.StatusInternalServerError)
			return
		}

		invokeSubsStoredCallback(onSubsStored, roomID)
		c.JSON(http.StatusCreated, gin.H{"subtitleTracks": tracks, "complete": req.complete()})
	}
}

// sanitizeSubtitleLanguage mirrors the player's safeLanguage: BCP-47-like
// tokens pass through, anything else becomes "und".
func sanitizeSubtitleLanguage(language string) string {
	if language == "" || len(language) > 35 {
		return "und"
	}
	for _, char := range language {
		if (char >= 'a' && char <= 'z') ||
			(char >= 'A' && char <= 'Z') ||
			(char >= '0' && char <= '9') ||
			char == '-' || char == '_' {
			continue
		}
		return "und"
	}
	return language
}

func validSubtitleTitle(value string) bool {
	if len(value) > maxSubtitleTitleBytes || !utf8.ValidString(value) {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func validSubtitleVTT(value string) bool {
	return len(value) > 0 && len(value) <= maxSubtitleVTTBytes &&
		utf8.ValidString(value) && strings.HasPrefix(value, "WEBVTT")
}

func invokeSubsStoredCallback(onSubsStored func(string), roomID string) {
	if onSubsStored == nil {
		return
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			slog.Error("subtitles stored callback panicked", "room_id", roomID, "panic", recovered)
		}
	}()
	onSubsStored(roomID)
}

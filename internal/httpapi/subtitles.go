package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
)

const (
	maxSubtitlesBodyBytes = 24 << 20
	maxSubtitleTracks     = 64
	maxSubtitleVTTBytes   = 4 << 20
	maxSubtitleASSBytes   = 4 << 20
	maxSubtitleTitleBytes = 255
	maxSubtitleFontBytes  = 8 << 20
	maxSubtitleFonts      = 24
)

// clientSubtitleTrack carries one extracted track. A nil VTT means unchanged since
// the last post, so the file already on disk stands; an ASS document, when present,
// makes the track codec "ass" with the VTT as fallback.
type clientSubtitleTrack struct {
	Language string  `json:"language"`
	Title    string  `json:"title"`
	VTT      *string `json:"vtt"`
	ASS      *string `json:"ass"`
}

// clientSubtitlesRequest is one publish of a browser extraction. Complete=false
// means a progressive publish, which keeps the ffmpeg pass scheduled; MediaGeneration
// names the source read, since an extraction can outlive the video it started on.
// Both fields absent means an older client, and are read as complete/unknown.
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

// SubtitlePublisher copies a room's subtitle files to the bucket viewers read from.
type SubtitlePublisher interface {
	PublishSubtitles(ctx context.Context, roomID, subsDir string) error
}

// RegisterSubtitlesRoute mounts the browser-extracted subtitle upload endpoints.
// onSubsStored fires after the tracks are persisted (nil-safe).
func RegisterSubtitlesRoute(rg *gin.RouterGroup, store *room.Store, cfg config.Config,
	publisher SubtitlePublisher, onSubsStored func(roomID string)) {
	rg.POST("/rooms/:id/subtitles", storeClientSubtitles(store, cfg, publisher, onSubsStored))
	rg.POST("/rooms/:id/subtitles/fleet", storeFleetSubtitles(store, cfg, publisher, onSubsStored))
	rg.POST("/rooms/:id/subtitles/fonts", storeSubtitleFont(store, cfg, publisher, onSubsStored))
}

// fleetSubtitlesRequest is a worker's publish of the tracks its FFmpeg pass
// extracted: the producer claim is the authorization, as for media.
type fleetSubtitlesRequest struct {
	Claim string `json:"claim" binding:"required"`
	clientSubtitlesRequest
}

// storeFleetSubtitles takes the worker's merged tracks for the room. The claim
// must be the room's live producer reservation; the generation must be current.
func storeFleetSubtitles(store *room.Store, cfg config.Config, publisher SubtitlePublisher,
	onSubsStored func(roomID string)) gin.HandlerFunc {
	return func(c *gin.Context) {
		roomID := c.Param("id")
		if !validMediaRoomID(roomID) {
			c.Status(http.StatusNotFound)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxSubtitlesBodyBytes)
		var req fleetSubtitlesRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		storedRoom, ok := authorizeClaimValue(c, store, roomID, req.Claim)
		if !ok {
			return
		}
		if req.MediaGeneration == nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		persistSubtitles(c, store, cfg, publisher, onSubsStored, roomID, storedRoom, req.clientSubtitlesRequest)
	}
}

// fontExtensions is what a subtitle font upload may claim to be; the extension only
// picks the content type the opaque bytes are served back with.
var fontExtensions = map[string]struct{}{
	".ttf": {}, ".otf": {}, ".ttc": {}, ".woff": {}, ".woff2": {},
}

// storeSubtitleFont accepts one font a container attached for its ASS tracks:
// additive per generation, deduplicated by digest, and never gating media.
func storeSubtitleFont(store *room.Store, cfg config.Config, publisher SubtitlePublisher,
	onSubsStored func(roomID string)) gin.HandlerFunc {
	return func(c *gin.Context) {
		roomID := c.Param("id")
		if !validMediaRoomID(roomID) {
			c.Status(http.StatusNotFound)
			return
		}
		storedRoom, ok := loadLiveRoom(c, store, roomID)
		if !ok {
			return
		}
		if v := c.Query("mediaGeneration"); v != "" {
			if n, err := strconv.Atoi(v); err != nil || n != storedRoom.MediaGeneration {
				c.JSON(http.StatusConflict, gin.H{"error": "stale_generation"})
				return
			}
		}
		if len(storedRoom.SubtitleFonts) >= maxSubtitleFonts {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "too_many_fonts"})
			return
		}
		name := filepath.Base(c.Query("name"))
		ext := strings.ToLower(filepath.Ext(name))
		if _, allowed := fontExtensions[ext]; !allowed || !validSubtitleTitle(name) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_font"})
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxSubtitleFontBytes)
		body, err := io.ReadAll(c.Request.Body)
		if err != nil || len(body) == 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_font"})
			return
		}
		digest := subtitleDigest(string(body))
		file := "fonts/f_" + digest + ext
		for _, held := range storedRoom.SubtitleFonts {
			if held.File == file {
				c.JSON(http.StatusOK, gin.H{"subtitleFonts": storedRoom.SubtitleFonts})
				return
			}
		}

		subsDir := filepath.Join(cfg.DataDir, "rooms", roomID, "subs")
		if err := os.MkdirAll(filepath.Join(subsDir, "fonts"), 0o755); err != nil {
			c.Status(http.StatusInternalServerError)
			return
		}
		if err := os.WriteFile(filepath.Join(subsDir, file), body, 0o644); err != nil {
			c.Status(http.StatusInternalServerError)
			return
		}
		if publisher != nil {
			if err := publisher.PublishSubtitles(c.Request.Context(), roomID, subsDir); err != nil {
				slog.ErrorContext(c.Request.Context(), "upload subtitle font failed", "room_id", roomID, "error", err)
				c.Status(http.StatusInternalServerError)
				return
			}
		}
		fonts, err := store.AddSubtitleFont(c.Request.Context(), roomID, room.SubtitleFont{
			Name: name, File: file, Size: int64(len(body)),
		}, maxSubtitleFonts)
		if err != nil {
			if errors.Is(err, room.ErrNotFound) {
				c.Status(http.StatusNotFound)
				return
			}
			c.Status(http.StatusInternalServerError)
			return
		}
		invokeSubsStoredCallback(onSubsStored, roomID)
		c.JSON(http.StatusOK, gin.H{"subtitleFonts": fonts})
	}
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
		persistSubtitles(c, store, cfg, publisher, onSubsStored, roomID, storedRoom, req)
	}
}

// persistSubtitles validates, writes and announces one publish of tracks,
// whoever extracted them.
func persistSubtitles(c *gin.Context, store *room.Store, cfg config.Config, publisher SubtitlePublisher,
	onSubsStored func(roomID string), roomID string, storedRoom *room.Room, req clientSubtitlesRequest) {
	{
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
		held := make(map[int]room.TrackInfo, len(storedRoom.SubtitleTracks))
		for _, track := range storedRoom.SubtitleTracks {
			held[track.Index] = track
		}
		tracks := make([]room.TrackInfo, 0, len(req.Tracks))
		type pendingWrite struct {
			path string
			body string
		}
		writes := make([]pendingWrite, 0, len(req.Tracks))
		for i, track := range req.Tracks {
			previous, seen := held[i]
			if track.VTT == nil {
				if !seen || previous.Digest == "" ||
					previous.Language != sanitizeSubtitleLanguage(track.Language) || previous.Title != track.Title {
					c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
					return
				}
				tracks = append(tracks, previous)
				continue
			}
			if !validSubtitleTitle(track.Title) || !validSubtitleVTT(*track.VTT) {
				c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
				return
			}
			if track.ASS != nil && !validSubtitleASS(*track.ASS) {
				c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
				return
			}
			language := sanitizeSubtitleLanguage(track.Language)
			codec := "webvtt"
			payload := *track.VTT
			if track.ASS != nil {
				codec = "ass"
				payload += "\x00" + *track.ASS
			}
			digest := subtitleDigest(payload)
			tracks = append(tracks, room.TrackInfo{
				Index:    i,
				Language: language,
				Title:    track.Title,
				Codec:    codec,
				Digest:   digest,
			})
			if seen && previous.Digest == digest && previous.Language == language {
				continue
			}
			writes = append(writes, pendingWrite{
				path: filepath.Join(subsDir, fmt.Sprintf("sub_%d_%s.vtt", i, language)),
				body: *track.VTT,
			})
			if track.ASS != nil {
				writes = append(writes, pendingWrite{
					path: filepath.Join(subsDir, fmt.Sprintf("sub_%d_%s.ass", i, language)),
					body: *track.ASS,
				})
			}
		}

		if err := os.MkdirAll(subsDir, 0o755); err != nil {
			slog.ErrorContext(c.Request.Context(), "create subtitles directory failed", "room_id", roomID, "error", err)
			c.Status(http.StatusInternalServerError)
			return
		}
		for _, write := range writes {
			if err := os.WriteFile(write.path, []byte(write.body), 0o644); err != nil {
				slog.ErrorContext(c.Request.Context(), "write subtitle file failed", "room_id", roomID, "error", err)
				c.Status(http.StatusInternalServerError)
				return
			}
		}

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

// subtitleDigest names the bytes of one track with half a sha256, kept short
// because it rides in the room payload and in every viewer's <track> url.
func subtitleDigest(vtt string) string {
	sum := sha256.Sum256([]byte(vtt))
	return hex.EncodeToString(sum[:8])
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

// validSubtitleASS checks shape only: the document must open with the script info
// section (an optional BOM aside). Only libass in the viewer ever parses it.
func validSubtitleASS(value string) bool {
	if len(value) == 0 || len(value) > maxSubtitleASSBytes || !utf8.ValidString(value) {
		return false
	}
	trimmed := strings.TrimPrefix(value, "\uFEFF")
	return len(trimmed) > 13 && strings.EqualFold(trimmed[:13], "[Script Info]")
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

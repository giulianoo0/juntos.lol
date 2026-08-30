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
	// Fonts ride with ASS tracks so the renderer draws the faces the script
	// was authored against. Bounded hard: they are a courtesy, not media.
	maxSubtitleFontBytes = 8 << 20
	maxSubtitleFonts     = 24
)

// VTT is a pointer because omitting it means something: this track has not
// changed since the last post, so the file already on disk and in the bucket
// stands. The extraction republishes every few seconds and most tracks are
// finished long before the pass is, so most of a post is bytes the server
// already has — on the same uplink the remux is fighting for.
type clientSubtitleTrack struct {
	Language string  `json:"language"`
	Title    string  `json:"title"`
	VTT      *string `json:"vtt"`
	// ASS carries the full styled document beside the VTT conversion. A
	// track that has one is stored as codec "ass": the player renders the
	// document with libass and keeps the VTT as its fallback.
	ASS *string `json:"ass"`
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
	rg.POST("/rooms/:id/subtitles/fonts", storeSubtitleFont(store, cfg, publisher, onSubsStored))
}

// fontExtensions is what a subtitle font upload may claim to be. The bytes
// are stored and served as opaque binaries under a digest name; the extension
// only informs the content type they are served back with.
var fontExtensions = map[string]struct{}{
	".ttf": {}, ".otf": {}, ".ttc": {}, ".woff": {}, ".woff2": {},
}

// storeSubtitleFont accepts one font file a container attached for its ASS
// tracks. Fonts are additive per generation, deduplicated by digest, and
// bounded in count and size; they never gate media.
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
		// The bucket gets the bytes before the room announces them, the same
		// order the tracks follow.
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
				// Nothing new for this one, so the file on disk stands and the
				// metadata is carried over whole — the name it carries is part
				// of its path. The names must still match: a track list that
				// shifted under the client would otherwise hand this index the
				// previous occupant's file, silently and for good.
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
				// One digest names both files: they grow and travel together.
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
			// An older client posts every track every time; the digest is what
			// keeps that from rewriting files nobody changed.
			if seen && previous.Digest == digest && previous.Language == language {
				continue
			}
			// i and the sanitized language keep the file name path-safe.
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

// Names the bytes of one track. Half a sha256 is far more than enough to tell
// two versions of the same file apart, and it rides in the room payload and in
// every viewer's <track> url, both of which are worth keeping short.
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

// validSubtitleASS accepts a complete ASS/SSA document. It must open with the
// script info section (an optional BOM aside); the file is served verbatim as
// text and only ever parsed by libass in the viewer, so shape is all that is
// checked here.
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

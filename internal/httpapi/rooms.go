package httpapi

import (
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	gonanoid "github.com/matoous/go-nanoid/v2"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
)

const (
	maxCreateRoomBodyBytes = 4 << 10
	maxFileNameBytes       = 255
	maxNicknameBytes       = 64
)

// RegisterRoomRoutes mounts the room creation and lookup endpoints on rg.
func RegisterRoomRoutes(rg *gin.RouterGroup, store *room.Store, cfg config.Config) {
	rg.POST("/rooms", createRoom(store, cfg))
	rg.GET("/rooms/:id", getRoom(store))
}

type createRoomRequest struct {
	FileName string `json:"fileName" binding:"required"`
	Nickname string `json:"nickname"`
}

func createRoom(store *room.Store, cfg config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxCreateRoomBodyBytes)
		var req createRoomRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		if !validFileName(req.FileName) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		nickname, err := displayNameOrRandom(req.Nickname)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
			return
		}
		if !validDisplayName(nickname) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}

		id, err := gonanoid.New(8)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
			return
		}

		now := time.Now()
		member := room.Member{ID: "m1", Nickname: nickname, JoinedAt: now}
		r := &room.Room{
			ID:           id,
			FileName:     req.FileName,
			Status:       "uploading",
			ControllerID: member.ID,
			CreatedAt:    now,
			ExpiresAt:    now.Add(time.Duration(cfg.RoomTTLHours) * time.Hour),
		}
		if err := store.CreateWithMember(c.Request.Context(), r, member); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
			return
		}

		c.JSON(http.StatusCreated, gin.H{
			"id":               id,
			"nickname":         nickname,
			"uploadEndpoint":   "/api/upload/",
			"streamStartBytes": cfg.StreamStartMB << 20,
			"expiresAt":        r.ExpiresAt,
		})
	}
}

func displayNameOrRandom(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value != "" {
		return value, nil
	}
	suffix, err := gonanoid.New(6)
	if err != nil {
		return "", err
	}
	return "Guest-" + suffix, nil
}

func validFileName(value string) bool {
	return validRoomText(value, maxFileNameBytes) && filepath.Base(value) == value && value != "."
}

func validDisplayName(value string) bool {
	return validRoomText(value, maxNicknameBytes)
}

func validRoomText(value string, maxBytes int) bool {
	if value == "" || len(value) > maxBytes || !utf8.ValidString(value) || strings.TrimSpace(value) == "" {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func getRoom(store *room.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		r, err := store.Get(c.Request.Context(), c.Param("id"))
		if errors.Is(err, room.ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "room_not_found"})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
			return
		}
		members, err := store.Members(c.Request.Context(), r.ID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"id":                r.ID,
			"fileName":          r.FileName,
			"status":            r.Status,
			"errorMessage":      r.ErrorMessage,
			"controllerId":      r.ControllerID,
			"audioTracks":       r.AudioTracks,
			"subtitleTracks":    r.SubtitleTracks,
			"bitmapSubsSkipped": r.BitmapSubsSkipped,
			"memberCount":       len(members),
			"createdAt":         r.CreatedAt,
			"expiresAt":         r.ExpiresAt,
		})
	}
}

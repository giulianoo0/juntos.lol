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
	"github.com/giulianoo0/ss/internal/media"
	"github.com/giulianoo0/ss/internal/room"
)

// A room id is read off a screen and typed back in by hand, so the alphabet is
// capitals and digits only: no mixed case, no - or _ to misread.
const (
	roomIDAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	roomIDLength   = 8
)

const (
	maxCreateRoomBodyBytes = 4 << 10
	maxFileNameBytes       = 255
	maxNicknameBytes       = 64
	maxRoomNameBytes       = 80
)

func RegisterRoomRoutes(rg *gin.RouterGroup, store *room.Store, cfg config.Config, authorizer ...memberAuthorizer) {
	var members memberAuthorizer
	if len(authorizer) > 0 {
		members = authorizer[0]
	}
	rg.POST("/rooms", NewHumanGate(cfg).Require(), roomCreationLimit(cfg.RoomsPerIPPerHour, cfg.BehindCloudflare), createRoom(store, cfg))
	rg.GET("/rooms/:id", getRoom(store, cfg.MediaPublicURL, members))
}

// Headers a member names itself with on reads of a room behind a door.
const (
	memberIDHeader   = "X-Member-Id"
	capabilityHeader = "X-Capability"
)

// createRoomRequest names the room and its creator. A room is born empty:
// what it plays arrives later through /source, /live or a screen.
type createRoomRequest struct {
	Nickname string `json:"nickname"`
	Name     string `json:"name"`
	// JoinMode and Password set the room's door; see joinAccess.
	JoinMode string `json:"joinMode"`
	Password string `json:"password"`
}

func createRoom(store *room.Store, cfg config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxCreateRoomBodyBytes)
		var req createRoomRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		name := strings.TrimSpace(req.Name)
		if name != "" && !validRoomText(name, maxRoomNameBytes) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		access, ok := joinAccess(c, req.JoinMode, req.Password)
		if !ok {
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

		id, err := gonanoid.Generate(roomIDAlphabet, roomIDLength)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
			return
		}

		ownerToken, err := gonanoid.New(32)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
			return
		}

		now := time.Now()
		member := room.Member{ID: "m1", Nickname: nickname, JoinedAt: now}
		r := &room.Room{
			ID:           id,
			Name:         name,
			Status:       room.StatusEmpty,
			ControllerID: member.ID,
			OwnerToken:   ownerToken,
			CreatedAt:    now,
			ExpiresAt:    now.Add(time.Duration(cfg.RoomTTLHours) * time.Hour),
		}
		if err := store.CreateWithMember(c.Request.Context(), r, member); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
			return
		}
		if err := store.SetAccess(c.Request.Context(), id, access); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
			return
		}

		c.JSON(http.StatusCreated, gin.H{
			"id":         id,
			"ownerToken": ownerToken,
			"nickname":   nickname,
			"name":       name,
			"status":     r.Status,
			"expiresAt":  r.ExpiresAt,
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

// getRoom answers with the room and the bucket base its media is served from. The
// base carries the media generation, so a source swap cannot be answered with the
// previous source's files.
func getRoom(store *room.Store, mediaBaseURL string, authorizer memberAuthorizer) gin.HandlerFunc {
	return func(c *gin.Context) {
		r, err := store.Get(c.Request.Context(), c.Param("id"))
		if errors.Is(err, room.ErrNotFound) || err == nil && !r.ExpiresAt.After(time.Now()) {
			c.JSON(http.StatusNotFound, gin.H{"error": "room_not_found"})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
			return
		}
		// Behind a password or the host's approval, what plays and where its
		// files are is for those inside; the door is /preview.
		if r.JoinMode != "" && r.JoinMode != room.JoinOpen {
			memberID, capability := c.GetHeader(memberIDHeader), c.GetHeader(capabilityHeader)
			if authorizer == nil || !authorizer.AuthorizeMember(r.ID, memberID, capability) {
				c.JSON(http.StatusForbidden, gin.H{"error": "room_locked", "joinMode": r.JoinMode})
				return
			}
		}
		members, err := store.Members(c.Request.Context(), r.ID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"id":                  r.ID,
			"name":                r.Name,
			"joinMode":            joinModeOf(r),
			"fileName":            r.FileName,
			"status":              r.Status,
			"mediaGeneration":     r.MediaGeneration,
			"mediaVersion":        r.MediaVersion,
			"durationMs":          r.DurationMs,
			"mediaOffsetMs":       r.MediaOffsetMs,
			"mediaRegions":        r.MediaRegions,
			"subsVersion":         r.SubsVersion,
			"gatingEnabled":       r.GatingEnabled,
			"errorMessage":        r.ErrorMessage,
			"controllerId":        r.ControllerID,
			"sourceMemberId":      r.SourceMemberID,
			"sourceOrigin":        r.SourceOrigin,
			"localSource":         r.LocalSource,
			"localCopy":           r.LocalCopy,
			"audioTracks":         r.AudioTracks,
			"subtitleTracks":      r.SubtitleTracks,
			"chapters":            r.Chapters,
			"bitmapSubsSkipped":   r.BitmapSubsSkipped,
			"producerHeartbeatMs": r.ProducerHeartbeatMs,
			"screens":             r.Screens,
			"live":                r.Live,
			"spotlight":           r.Spotlight,
			"preparation":         r.Preparation,
			"memberCount":         len(members),
			"createdAt":           r.CreatedAt,
			"expiresAt":           r.ExpiresAt,
			"mediaKey":            media.RoomKey(r.ID),
			"mediaBaseUrl":        strings.TrimSuffix(mediaBaseURL+"/"+media.MediaPrefix(r.ID, r.MediaGeneration), "/"),
		})
	}
}

func joinModeOf(r *room.Room) string {
	if r.JoinMode == "" {
		return room.JoinOpen
	}
	return r.JoinMode
}

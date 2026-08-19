package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/giulianoo0/ss/internal/room"
)

// RegisterMediaRoutes serves the HLS playlists of live rooms.
//
// Only playlists come from here. Segments, init files and subtitles are
// delivered straight from the bucket, so the bytes a viewer downloads never
// cross this machine — which is what lets a room outgrow one server.
//
// Keeping playlists here is deliberate. They are kilobytes, and this handler
// is the one request a viewer must make before anything plays, which makes it
// the place to check that the room still exists.
func RegisterMediaRoutes(r gin.IRoutes, store *room.Store) {
	r.GET("/media/:id/hls/*filepath", servePlaylist(store))
}

func servePlaylist(store *room.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Access-Control-Allow-Origin", "*")
		roomID := c.Param("id")
		if !validMediaRoomID(roomID) {
			c.Status(http.StatusNotFound)
			return
		}

		name := strings.TrimPrefix(c.Param("filepath"), "/")
		// A playlist name is a single file written by ffmpeg into one
		// directory, so anything with structure in it is not one.
		if name == "" || name != filepath.Base(name) || !strings.EqualFold(filepath.Ext(name), ".m3u8") {
			c.Status(http.StatusNotFound)
			return
		}

		storedRoom, err := store.Get(c.Request.Context(), roomID)
		if errors.Is(err, room.ErrNotFound) {
			c.Status(http.StatusNotFound)
			return
		}
		if err != nil {
			slog.ErrorContext(c.Request.Context(), "load room for media failed", "room_id", roomID, "error", err)
			c.Status(http.StatusInternalServerError)
			return
		}
		if !storedRoom.ExpiresAt.After(time.Now()) {
			c.Status(http.StatusNotFound)
			return
		}

		playlist, err := store.Playlist(c.Request.Context(), roomID, name)
		if errors.Is(err, room.ErrNotFound) {
			c.Status(http.StatusNotFound)
			return
		}
		if err != nil {
			slog.ErrorContext(c.Request.Context(), "load playlist failed",
				"room_id", roomID, "playlist", name, "error", err)
			c.Status(http.StatusInternalServerError)
			return
		}

		c.Header("Content-Type", "application/vnd.apple.mpegurl")
		// An event playlist grows with every segment the preview publishes,
		// and a cached one strands a viewer at whatever length it had.
		c.Header("Cache-Control", "no-store")
		c.String(http.StatusOK, playlist)
	}
}

func validMediaRoomID(roomID string) bool {
	return roomID != "." && !strings.ContainsAny(roomID, "*?[]") &&
		filepath.IsLocal(roomID) && filepath.Base(roomID) == roomID
}

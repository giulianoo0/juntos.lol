package httpapi

import (
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
)

// RegisterMediaRoutes serves browser-ready HLS and WebVTT files for live rooms.
func RegisterMediaRoutes(r gin.IRoutes, cfg config.Config, store *room.Store) {
	r.GET("/media/:id/hls/*filepath", serveMedia(cfg.DataDir, store, "hls"))
	r.GET("/media/:id/subs/*filepath", serveMedia(cfg.DataDir, store, "subs"))
}

func serveMedia(dataDir string, store *room.Store, mediaDir string) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Access-Control-Allow-Origin", "*")
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
			slog.ErrorContext(c.Request.Context(), "load room for media failed", "room_id", roomID, "error", err)
			c.Status(http.StatusInternalServerError)
			return
		}
		if !storedRoom.ExpiresAt.After(time.Now()) {
			c.Status(http.StatusNotFound)
			return
		}

		name := strings.TrimPrefix(c.Param("filepath"), "/")
		if !fs.ValidPath(name) || strings.ContainsRune(name, '\\') {
			c.Status(http.StatusBadRequest)
			return
		}

		root, err := openMediaRoot(dataDir, roomID, mediaDir)
		if err != nil {
			c.Status(http.StatusNotFound)
			return
		}
		defer root.Close()

		file, err := root.Open(name)
		if err != nil {
			c.Status(http.StatusNotFound)
			return
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() {
			c.Status(http.StatusNotFound)
			return
		}

		if contentType := mediaContentType(filepath.Ext(name)); contentType != "" {
			c.Header("Content-Type", contentType)
		}
		http.ServeContent(c.Writer, c.Request, filepath.Base(name), info.ModTime(), file)
	}
}

func openMediaRoot(dataDir, roomID, mediaDir string) (*os.Root, error) {
	roomsRoot, err := os.OpenRoot(filepath.Join(dataDir, "rooms"))
	if err != nil {
		return nil, err
	}
	defer roomsRoot.Close()

	roomInfo, err := roomsRoot.Lstat(roomID)
	if err != nil || roomInfo.Mode()&os.ModeSymlink != 0 || !roomInfo.IsDir() {
		return nil, fs.ErrNotExist
	}
	roomRoot, err := roomsRoot.OpenRoot(roomID)
	if err != nil {
		return nil, err
	}
	defer roomRoot.Close()

	mediaInfo, err := roomRoot.Lstat(mediaDir)
	if err != nil || mediaInfo.Mode()&os.ModeSymlink != 0 || !mediaInfo.IsDir() {
		return nil, fs.ErrNotExist
	}
	return roomRoot.OpenRoot(mediaDir)
}

func validMediaRoomID(roomID string) bool {
	return roomID != "." && !strings.ContainsAny(roomID, "*?[]") &&
		filepath.IsLocal(roomID) && filepath.Base(roomID) == roomID
}

func mediaContentType(ext string) string {
	switch strings.ToLower(ext) {
	case ".m3u8":
		return "application/vnd.apple.mpegurl"
	case ".ts":
		return "video/mp2t"
	case ".m4s", ".mp4":
		return "video/mp4"
	case ".vtt":
		return "text/vtt; charset=utf-8"
	default:
		return ""
	}
}

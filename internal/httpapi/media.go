package httpapi

import (
	"io/fs"
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
		if err != nil || !storedRoom.ExpiresAt.After(time.Now()) {
			c.Status(http.StatusNotFound)
			return
		}

		name := strings.TrimPrefix(c.Param("filepath"), "/")
		if !fs.ValidPath(name) || strings.ContainsRune(name, '\\') {
			c.Status(http.StatusBadRequest)
			return
		}

		root, err := os.OpenRoot(filepath.Join(dataDir, "rooms", roomID, mediaDir))
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

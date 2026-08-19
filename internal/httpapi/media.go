package httpapi

import (
	"bytes"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
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

		extension := filepath.Ext(name)
		if contentType := mediaContentType(extension); contentType != "" {
			c.Header("Content-Type", contentType)
		}
		c.Header("Cache-Control", mediaCacheControl(extension))
		// Event playlists grow during the progressive phase; never cache them.
		if strings.EqualFold(extension, ".m3u8") {
			playlist, err := io.ReadAll(file)
			if err != nil {
				c.Status(http.StatusInternalServerError)
				return
			}
			playlist = normalizeEventPlaylist(playlist)
			http.ServeContent(c.Writer, c.Request, filepath.Base(name), info.ModTime(), bytes.NewReader(playlist))
			return
		}
		http.ServeContent(c.Writer, c.Request, filepath.Base(name), info.ModTime(), file)
	}
}

// normalizeEventPlaylist makes a growing episode start at its beginning in
// native HLS players and repairs ffmpeg's occasionally too-small target
// duration for AAC segments that run a few milliseconds over the boundary.
func normalizeEventPlaylist(playlist []byte) []byte {
	text := string(playlist)
	if !strings.Contains(text, "#EXT-X-PLAYLIST-TYPE:EVENT") {
		return playlist
	}

	lines := strings.Split(strings.TrimSuffix(text, "\n"), "\n")
	targetIndex := -1
	targetDuration := 0
	maxSegmentDuration := 0.0
	hasStart := false
	for index, line := range lines {
		switch {
		case strings.HasPrefix(line, "#EXT-X-TARGETDURATION:"):
			targetIndex = index
			targetDuration, _ = strconv.Atoi(strings.TrimPrefix(line, "#EXT-X-TARGETDURATION:"))
		case strings.HasPrefix(line, "#EXTINF:"):
			value := strings.TrimPrefix(line, "#EXTINF:")
			value, _, _ = strings.Cut(value, ",")
			if duration, err := strconv.ParseFloat(value, 64); err == nil {
				maxSegmentDuration = max(maxSegmentDuration, duration)
			}
		case strings.HasPrefix(line, "#EXT-X-START:"):
			hasStart = true
		}
	}

	minimumTarget := int(math.Ceil(maxSegmentDuration))
	if targetIndex >= 0 && targetDuration < minimumTarget {
		lines[targetIndex] = "#EXT-X-TARGETDURATION:" + strconv.Itoa(minimumTarget)
	}
	if !hasStart {
		for index, line := range lines {
			if line == "#EXT-X-PLAYLIST-TYPE:EVENT" {
				lines = append(lines[:index+1], append([]string{"#EXT-X-START:TIME-OFFSET=0,PRECISE=YES"}, lines[index+1:]...)...)
				break
			}
		}
	}
	return []byte(strings.Join(lines, "\n") + "\n")
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

// mediaCacheControl decides how long each kind of media file may be held.
//
// Segments and init files never change once written: their names carry a
// sequence number, and a new encode writes new names. Letting the edge keep
// them is what turns the server's own bandwidth from the ceiling on how many
// people can watch into a detail — every viewer after the first is served
// without touching this machine.
//
// Playlists are the opposite: an event playlist grows with every segment the
// progressive remux publishes, and a stale one strands a viewer at whatever
// length it was cached. Subtitles change too, but their URLs carry a version,
// so a fresh URL is a fresh object.
func mediaCacheControl(ext string) string {
	switch strings.ToLower(ext) {
	case ".m3u8":
		return "no-store"
	case ".vtt":
		return "public, max-age=3600"
	default:
		return "public, max-age=31536000, immutable"
	}
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

package httpapi

import (
	"bytes"
	"compress/gzip"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/giulianoo0/ss/internal/room"
)

// RegisterMediaRoutes serves only the HLS playlists of live rooms: segments, init
// files and subtitles come straight from the bucket. Playlists stay here because
// they are the one request a viewer must make before anything plays.
func RegisterMediaRoutes(r gin.IRoutes, store *room.Store, waiter *playlistWaiter) {
	r.GET("/media/:id/hls/*filepath", servePlaylist(store, waiter))
	r.GET("/media/:id/bundle", serveBundle(store))
}

// serveBundle hands a master and every media playlist it names in one response,
// collapsing the round trips a region switch would otherwise cost.
func serveBundle(store *room.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Access-Control-Allow-Origin", "*")
		roomID := c.Param("id")
		master := c.Query("master")
		if !validMediaRoomID(roomID) || master == "" || master != filepath.Base(master) || !strings.EqualFold(filepath.Ext(master), ".m3u8") {
			c.Status(http.StatusNotFound)
			return
		}
		ctx := c.Request.Context()
		storedRoom, err := store.Get(ctx, roomID)
		if errors.Is(err, room.ErrNotFound) || (err == nil && !storedRoom.ExpiresAt.After(time.Now())) {
			c.Status(http.StatusNotFound)
			return
		}
		if err != nil {
			c.Status(http.StatusInternalServerError)
			return
		}
		body, err := store.Playlist(ctx, roomID, master)
		if errors.Is(err, room.ErrNotFound) {
			c.Status(http.StatusNotFound)
			return
		}
		if err != nil {
			c.Status(http.StatusInternalServerError)
			return
		}
		playlists := make(map[string]string)
		for _, name := range masterPlaylistNames(body) {
			media, err := store.Playlist(ctx, roomID, name)
			if err != nil {
				continue
			}
			playlists[name] = withBlockingReload(media)
		}
		c.Header("Cache-Control", "no-store")
		c.JSON(http.StatusOK, gin.H{"master": body, "playlists": playlists})
	}
}

// masterPlaylistNames lists the media playlists a master refers to: bare
// lines under EXT-X-STREAM-INF, and the URI of every EXT-X-MEDIA.
func masterPlaylistNames(master string) []string {
	var names []string
	seen := make(map[string]struct{})
	add := func(name string) {
		name = strings.TrimSpace(name)
		if name == "" || name != filepath.Base(name) || !strings.HasSuffix(name, ".m3u8") {
			return
		}
		if _, ok := seen[name]; ok {
			return
		}
		seen[name] = struct{}{}
		names = append(names, name)
	}
	for _, line := range strings.Split(master, "\n") {
		trimmed := strings.TrimSpace(line)
		switch {
		case trimmed == "":
		case strings.HasPrefix(trimmed, "#EXT-X-MEDIA:"):
			if _, after, ok := strings.Cut(trimmed, `URI="`); ok {
				if uri, _, ok := strings.Cut(after, `"`); ok {
					add(uri)
				}
			}
		case strings.HasPrefix(trimmed, "#"):
		default:
			add(trimmed)
		}
	}
	return names
}

func servePlaylist(store *room.Store, waiter *playlistWaiter) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Access-Control-Allow-Origin", "*")
		roomID := c.Param("id")
		if !validMediaRoomID(roomID) {
			c.Status(http.StatusNotFound)
			return
		}

		name := strings.TrimPrefix(c.Param("filepath"), "/")
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

		published := waiter.channel(roomID)
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
		if wanted, ok := requestedSequence(c.Request.URL.RawQuery); ok {
			deadline := time.Now().Add(blockingReloadMax)
			for {
				reach, ended := playlistReach(playlist)
				if ended || wanted <= reach {
					break
				}
				if !waiter.wait(c.Request.Context(), published, deadline) {
					if c.Request.Context().Err() != nil {
						return
					}
					break
				}
				published = waiter.channel(roomID)
				next, err := store.Playlist(c.Request.Context(), roomID, name)
				if err != nil {
					break
				}
				playlist = next
			}
		}
		playlist = withBlockingReload(playlist)

		c.Header("Content-Type", "application/vnd.apple.mpegurl")
		c.Header("Cache-Control", "no-store")
		c.Header("Vary", "Accept-Encoding")
		writePlaylist(c, playlist)
	}
}

// gzipWorthIt is the size below which a playlist is a master or a barely started
// room, where gzip costs bytes instead of saving them.
const gzipWorthIt = 512

var gzipWriters = sync.Pool{New: func() any { w, _ := gzip.NewWriterLevel(io.Discard, gzip.BestSpeed); return w }}

func writePlaylist(c *gin.Context, playlist string) {
	if len(playlist) < gzipWorthIt || !acceptsGzip(c.GetHeader("Accept-Encoding")) {
		c.String(http.StatusOK, playlist)
		return
	}
	var body bytes.Buffer
	writer := gzipWriters.Get().(*gzip.Writer)
	defer func() { writer.Reset(io.Discard); gzipWriters.Put(writer) }()
	writer.Reset(&body)
	if _, err := io.WriteString(writer, playlist); err != nil {
		c.String(http.StatusOK, playlist)
		return
	}
	if err := writer.Close(); err != nil {
		c.String(http.StatusOK, playlist)
		return
	}
	c.Header("Content-Encoding", "gzip")
	c.Data(http.StatusOK, "application/vnd.apple.mpegurl", body.Bytes())
}

// acceptsGzip reports gzip named in Accept-Encoding, and not named only to be refused.
func acceptsGzip(header string) bool {
	for _, part := range strings.Split(header, ",") {
		fields := strings.Split(strings.TrimSpace(part), ";")
		if !strings.EqualFold(strings.TrimSpace(fields[0]), "gzip") {
			continue
		}
		for _, param := range fields[1:] {
			if strings.EqualFold(strings.TrimSpace(param), "q=0") {
				return false
			}
		}
		return true
	}
	return false
}

func validMediaRoomID(roomID string) bool {
	return roomID != "." && !strings.ContainsAny(roomID, "*?[]") &&
		filepath.IsLocal(roomID) && filepath.Base(roomID) == roomID
}

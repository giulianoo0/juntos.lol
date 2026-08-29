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

	"github.com/giulianoo0/ss/internal/metrics"
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
func RegisterMediaRoutes(r gin.IRoutes, store *room.Store, waiter *playlistWaiter) {
	r.GET("/media/:id/hls/*filepath", servePlaylist(store, waiter))
	r.GET("/media/:id/bundle", serveBundle(store))
}

// serveBundle hands a master and every media playlist it names in one
// response. A region switch otherwise costs the player a master, then the
// video and audio playlists, then the init segments, each a round trip
// behind the last; with the bundle the playlists arrive together and the
// init segments can be fetched before hls.js asks.
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
				// A rendition whose playlist is not stored yet is the
				// player's to fetch and retry on its own schedule.
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

		// Taken before the read below: a publish that lands between the two
		// closes this channel, and the wait returns at once.
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
		// A player that asks for a sequence the playlist has not reached is
		// held until a publish gets it there — or until the wait runs out,
		// when it gets the playlist as it stands, which hls.js reads as a
		// missed update and not as an error.
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
		// An event playlist grows with every segment the preview publishes,
		// and a cached one strands a viewer at whatever length it had.
		c.Header("Cache-Control", "no-store")
		c.Header("Vary", "Accept-Encoding")
		// Counted separately from the route's response bytes so the figure
		// survives the playlists ever moving behind another route. It is also
		// all the media this process serves: segments and subtitles are
		// fetched from the bucket's edge and never cross this machine. What is
		// counted is what left the machine, compressed or not.
		metrics.MediaBytesServed.WithLabelValues("playlist").Add(float64(writePlaylist(c, playlist)))
	}
}

// A playlist is a column of near-identical urls: it compresses about twenty
// to one, and hls.js asks for it again every few seconds per rendition for as
// long as the room is still growing. The edge compresses what it forwards to
// the viewer, but only this leg decides what leaves this machine. Fastest
// setting on purpose — on a real playlist the slower ones buy a few hundred
// bytes for three times the cpu, and this box has one job it cannot fall
// behind on.
// Below this a playlist is a master or a room that has barely started, and
// compressing costs bytes instead of saving them.
const gzipWorthIt = 512

var gzipWriters = sync.Pool{New: func() any { w, _ := gzip.NewWriterLevel(io.Discard, gzip.BestSpeed); return w }}

// Writes the playlist and returns how many bytes that put on the wire.
func writePlaylist(c *gin.Context, playlist string) int {
	// A master is a few hundred bytes and gzip's own header costs more than it
	// saves there — and the master is the one playlist re-fetched on every
	// region switch.
	if len(playlist) < gzipWorthIt || !acceptsGzip(c.GetHeader("Accept-Encoding")) {
		c.String(http.StatusOK, playlist)
		return len(playlist)
	}
	var body bytes.Buffer
	writer := gzipWriters.Get().(*gzip.Writer)
	// Reset before going back so the pool does not hold this response's buffer.
	defer func() { writer.Reset(io.Discard); gzipWriters.Put(writer) }()
	writer.Reset(&body)
	if _, err := io.WriteString(writer, playlist); err != nil {
		c.String(http.StatusOK, playlist)
		return len(playlist)
	}
	if err := writer.Close(); err != nil {
		c.String(http.StatusOK, playlist)
		return len(playlist)
	}
	c.Header("Content-Encoding", "gzip")
	c.Data(http.StatusOK, "application/vnd.apple.mpegurl", body.Bytes())
	return body.Len()
}

// gzip named in Accept-Encoding, and not named only to be refused.
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

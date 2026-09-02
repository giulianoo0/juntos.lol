package media

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/giulianoo0/ss/internal/objectstore"
	"github.com/giulianoo0/ss/internal/room"
)

const (
	uploadTimeout = 5 * time.Minute

	subtitleCacheControl = "public, max-age=3600"

	maxRememberedSubtitles = 4096
)

// Publisher moves the subtitle files a host's browser extracted into the
// bucket they are served from. The video itself never passes through here
// (see clientmedia.go).
type Publisher struct {
	store  *room.Store
	bucket objectstore.Store

	subsMu        sync.Mutex
	sentSubtitles map[string][sha256.Size]byte
}

func NewPublisher(store *room.Store, bucket objectstore.Store, _ string) *Publisher {
	return &Publisher{
		store:         store,
		bucket:        bucket,
		sentSubtitles: make(map[string][sha256.Size]byte),
	}
}

// MediaPrefix is where one generation of a room's media lives. The generation
// is in the path because segment names repeat, and those URLs are handed to
// the edge as immutable for a year.
func MediaPrefix(roomID string, generation int) string {
	return "rooms/" + roomID + "/g" + strconv.Itoa(generation) + "/"
}

func hlsPrefix(roomID string, generation int) string { return MediaPrefix(roomID, generation) + "hls/" }
func subsPrefix(roomID string, generation int) string {
	return MediaPrefix(roomID, generation) + "subs/"
}

var subtitleContentTypes = map[string]string{
	".vtt":   "text/vtt; charset=utf-8",
	".ass":   "text/x-ssa; charset=utf-8",
	".ttf":   "font/ttf",
	".otf":   "font/otf",
	".ttc":   "font/collection",
	".woff":  "font/woff",
	".woff2": "font/woff2",
}

// PublishSubtitles uploads every subtitle file in subsDir — WebVTT, the ASS
// documents beside them, and the fonts/ directory — whose content is not
// already in the bucket.
func (p *Publisher) PublishSubtitles(ctx context.Context, roomID, subsDir string) error {
	generation, err := p.generation(ctx, roomID)
	if err != nil {
		return err
	}
	if err := p.publishSubtitleDir(ctx, subsPrefix(roomID, generation), subsDir); err != nil {
		return err
	}
	return p.publishSubtitleDir(ctx, subsPrefix(roomID, generation)+"fonts/",
		filepath.Join(subsDir, "fonts"))
}

func (p *Publisher) publishSubtitleDir(ctx context.Context, prefix, dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("list subtitles: %w", err)
	}
	for _, entry := range entries {
		contentType, known := subtitleContentTypes[strings.ToLower(filepath.Ext(entry.Name()))]
		if entry.IsDir() || !known {
			continue
		}
		if err := p.putSubtitle(ctx, prefix+entry.Name(),
			filepath.Join(dir, entry.Name()), contentType); err != nil {
			return err
		}
	}
	return nil
}

// putSubtitle uploads one WebVTT file unless the bucket already holds exactly
// these bytes under this key.
func (p *Publisher) putSubtitle(ctx context.Context, key, path, contentType string) error {
	body, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return err
		}
		return fmt.Errorf("read %s for upload: %w", filepath.Base(path), err)
	}
	digest := sha256.Sum256(body)
	if p.subtitleSent(key, digest) {
		return nil
	}
	uploadCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), uploadTimeout)
	defer cancel()
	if err := p.bucket.Put(uploadCtx, key, bytes.NewReader(body), int64(len(body)),
		contentType, subtitleCacheControl); err != nil {
		return err
	}
	p.rememberSubtitle(key, digest)
	return nil
}

func (p *Publisher) subtitleSent(key string, digest [sha256.Size]byte) bool {
	p.subsMu.Lock()
	defer p.subsMu.Unlock()
	sent, ok := p.sentSubtitles[key]
	return ok && sent == digest
}

func (p *Publisher) rememberSubtitle(key string, digest [sha256.Size]byte) {
	p.subsMu.Lock()
	defer p.subsMu.Unlock()
	if p.sentSubtitles == nil {
		p.sentSubtitles = make(map[string][sha256.Size]byte)
	}
	if len(p.sentSubtitles) >= maxRememberedSubtitles {
		clear(p.sentSubtitles)
	}
	p.sentSubtitles[key] = digest
}

func (p *Publisher) rememberedSubtitles() int {
	p.subsMu.Lock()
	defer p.subsMu.Unlock()
	return len(p.sentSubtitles)
}

// generation reads which source the room is currently on: every object key
// carries it, so a swap cannot collide with the previous source's objects.
func (p *Publisher) generation(ctx context.Context, roomID string) (int, error) {
	storedRoom, err := p.store.Get(ctx, roomID)
	if err != nil {
		return 0, fmt.Errorf("load room generation: %w", err)
	}
	return storedRoom.MediaGeneration, nil
}

// renderPlaylistWithBase rewrites a playlist for delivery and reports whether
// it is worth publishing at all. A master is returned unchanged; a media
// playlist gets bucket URLs and is cut at the last confirmed segment.
func renderPlaylistWithBase(baseURL, roomID string, generation int, body []byte,
	published map[string]struct{}) (string, bool) {
	if isMasterPlaylist(body) {
		return string(body), true
	}
	base := baseURL + "/" + hlsPrefix(roomID, generation)
	lines := strings.Split(strings.TrimSuffix(string(normalizeEventPlaylist(body)), "\n"), "\n")
	out := make([]string, 0, len(lines))
	pending := make([]string, 0, 8)
	segments := 0
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(trimmed, "#EXT-X-MAP:"):
			uri, ok := mapURI(trimmed)
			if !ok {
				return "", false
			}
			if _, done := published[uri]; !done {
				return "", false
			}
			pending = append(pending, `#EXT-X-MAP:URI="`+base+uri+`"`)
		case trimmed == "" || strings.HasPrefix(trimmed, "#"):
			pending = append(pending, line)
		default:
			if _, done := published[trimmed]; !done {
				return joinPlaylist(out, segments)
			}
			out = append(out, pending...)
			pending = pending[:0]
			out = append(out, base+trimmed)
			segments++
		}
	}
	out = append(out, pending...)
	return joinPlaylist(out, segments)
}

func joinPlaylist(lines []string, segments int) (string, bool) {
	if segments == 0 {
		return "", false
	}
	return strings.Join(lines, "\n") + "\n", true
}

func playlistObjects(body []byte) []string {
	if isMasterPlaylist(body) {
		return nil
	}
	var objects []string
	for line := range strings.SplitSeq(string(body), "\n") {
		trimmed := strings.TrimSpace(line)
		switch {
		case trimmed == "":
		case strings.HasPrefix(trimmed, "#EXT-X-MAP:"):
			if uri, ok := mapURI(trimmed); ok {
				objects = append(objects, uri)
			}
		case strings.HasPrefix(trimmed, "#"):
		default:
			objects = append(objects, trimmed)
		}
	}
	return objects
}

func isMasterPlaylist(body []byte) bool {
	return bytes.Contains(body, []byte("#EXT-X-STREAM-INF"))
}

func mapURI(line string) (string, bool) {
	_, rest, found := strings.Cut(line, `URI="`)
	if !found {
		return "", false
	}
	uri, _, found := strings.Cut(rest, `"`)
	if !found || uri == "" {
		return "", false
	}
	return uri, true
}

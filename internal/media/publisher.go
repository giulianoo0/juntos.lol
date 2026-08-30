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

// previewPublishPatterns are the playlists the progressive preview owns, and
// finalPublishPatterns the ones a finished encode owns.
const (
	// uploadTimeout bounds one object upload. It is deliberately generous
	// because the alternative to a slow upload is an aborted one, and an
	// aborted PUT is not a no-op: the bucket keeps an object that reads back
	// intact over the S3 API while the edge serves it truncated.
	uploadTimeout = 5 * time.Minute

	// subtitleCacheControl is short because progressive extraction rewrites
	// the same name as it reads further into the file.
	subtitleCacheControl = "public, max-age=3600"

	// maxRememberedSubtitles bounds the record of which subtitle files already
	// reached the bucket. The record lives as long as the process, and without
	// a ceiling it would grow for every room the server ever published.
	// Forgetting all of it costs one redundant upload per track still being
	// extracted, which is the cheaper failure.
	maxRememberedSubtitles = 4096
)

// Publisher moves the subtitle files a host's browser extracted into the
// bucket they are served from. The video itself never passes through here:
// the host's browser PUTs its own segments, and the server only renders the
// playlists that point at them (see clientmedia.go).
type Publisher struct {
	store  *room.Store
	bucket objectstore.Store

	// sentSubtitles digests the subtitle files already in the bucket, keyed by
	// the object key they landed on. Progressive extraction rewrites every
	// track's file on every tick whether or not its cues moved, so without this
	// a track that ran out of dialogue is uploaded again on each one.
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

// MediaPrefix is where one generation of a room's media lives.
//
// The generation is in the path because segment names repeat: swap the source
// and the next remux writes cs_1_0.m4s again. Those URLs are handed to the
// edge as immutable for a year, so reusing them would serve the previous
// video from cache with no way to correct it.
func MediaPrefix(roomID string, generation int) string {
	return "rooms/" + roomID + "/g" + strconv.Itoa(generation) + "/"
}

func hlsPrefix(roomID string, generation int) string { return MediaPrefix(roomID, generation) + "hls/" }
func subsPrefix(roomID string, generation int) string {
	return MediaPrefix(roomID, generation) + "subs/"
}

// subtitleContentTypes is what a subtitle-adjacent file is served back as,
// keyed by extension. Anything else in the directory is skipped.
var subtitleContentTypes = map[string]string{
	".vtt":   "text/vtt; charset=utf-8",
	".ass":   "text/x-ssa; charset=utf-8",
	".ttf":   "font/ttf",
	".otf":   "font/otf",
	".ttc":   "font/collection",
	".woff":  "font/woff",
	".woff2": "font/woff2",
}

// PublishSubtitles uploads every subtitle file in subsDir — WebVTT, the full
// ASS documents beside them, and the fonts/ directory of attached faces —
// whose content is not already in the bucket. Subtitle URLs are built by the
// client, so they carry a version query string of their own and do not need
// the published set.
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
//
// The file is read whole rather than streamed: subtitles are kilobytes, and
// the read is what the digest is taken from anyway.
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
	// Detached from the caller's cancellation for the same reason a segment
	// upload is: an aborted PUT leaves an object that reads back intact over
	// the S3 API and is served truncated from the edge.
	uploadCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), uploadTimeout)
	defer cancel()
	if err := p.bucket.Put(uploadCtx, key, bytes.NewReader(body), int64(len(body)),
		contentType, subtitleCacheControl); err != nil {
		return err
	}
	// Recorded only once the bytes are in the bucket, so a failed upload is
	// retried by the next pass rather than assumed done.
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

// generation reads which source the room is currently on. Every object key
// carries it, so a swap cannot collide with what the previous source left in
// the bucket or at the edge.
func (p *Publisher) generation(ctx context.Context, roomID string) (int, error) {
	storedRoom, err := p.store.Get(ctx, roomID)
	if err != nil {
		return 0, fmt.Errorf("load room generation: %w", err)
	}
	return storedRoom.MediaGeneration, nil
}

// renderPlaylistWithBase rewrites a playlist for delivery and reports whether
// it is worth publishing at all.
//
// A master playlist is returned unchanged: its URIs name variant playlists,
// which the application still serves. A media playlist gets bucket URLs and
// is cut at the last segment the bucket has confirmed.
func renderPlaylistWithBase(baseURL, roomID string, generation int, body []byte,
	published map[string]struct{}) (string, bool) {
	if isMasterPlaylist(body) {
		return string(body), true
	}
	base := baseURL + "/" + hlsPrefix(roomID, generation)
	lines := strings.Split(strings.TrimSuffix(string(normalizeEventPlaylist(body)), "\n"), "\n")
	out := make([]string, 0, len(lines))
	// pending holds tags read since the last emitted segment. They describe
	// the segment that follows, so they are only earned once it is confirmed.
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
				// Nothing in this playlist decodes without its init segment.
				return "", false
			}
			pending = append(pending, `#EXT-X-MAP:URI="`+base+uri+`"`)
		case trimmed == "" || strings.HasPrefix(trimmed, "#"):
			pending = append(pending, line)
		default:
			if _, done := published[trimmed]; !done {
				// From here on the playlist describes segments the bucket has
				// not confirmed. A viewer gets a shorter playlist and waits;
				// a viewer never gets a URL that 404s. Whatever sat in pending
				// belongs to the missing segment, including any end marker:
				// a cut playlist must not claim to be finished.
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

// playlistObjects names every object a media playlist references.
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

// mapURI reads the URI out of an EXT-X-MAP tag.
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

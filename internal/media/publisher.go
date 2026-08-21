package media

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/giulianoo0/ss/internal/objectstore"
	"github.com/giulianoo0/ss/internal/room"
)

// previewPublishPatterns are the playlists the progressive preview owns, and
// finalPublishPatterns the ones a finished encode owns.
//
// The two passes write into the same directory, and the final ladder must not
// become reachable before its own pass says so. The final list keeps the
// preview playlists because they outlive the swap on purpose: a viewer who
// joined during the preview may still be reading them.
var (
	previewPublishPatterns = []string{"master.m3u8", "preview_stream_*.m3u8"}
	finalPublishPatterns   = []string{"master.m3u8", "stream_*.m3u8", "preview_stream_*.m3u8"}
)

const (
	// PublishInterval is how often a running encode pushes new output to the
	// bucket. Well inside one preview segment, so a segment leaves for the
	// bucket about as soon as the muxer finishes writing it: the preview is
	// what a viewer waits on.
	PublishInterval = time.Second

	// uploadTimeout bounds one object upload. It is deliberately generous
	// because the alternative to a slow upload is an aborted one, and an
	// aborted PUT is not a no-op: the bucket keeps an object that reads back
	// intact over the S3 API while the edge serves it truncated, so the room
	// loses its video and no cache purge brings it back.
	uploadTimeout = 5 * time.Minute
	// uploadConcurrency is how many objects are sent to the bucket at once.
	uploadConcurrency = 8
	// publishBatchSize is how many objects land between two republishes of the
	// playlists. Small enough that a viewer sees the edge move while a backlog
	// drains, large enough that the bookkeeping stays a rounding error.
	publishBatchSize = 32

	// bookkeepingTimeout bounds the record of what reached the bucket. It
	// outlives the cancellation that stopped the uploads, or the objects paid
	// for would be uploaded again by the next pass.
	bookkeepingTimeout = 10 * time.Second

	// immutableCacheControl is for segments and init files. Their names carry
	// a sequence number and a new encode writes new names, so an edge copy can
	// never go stale.
	immutableCacheControl = "public, max-age=31536000, immutable"
	// subtitleCacheControl is shorter because progressive extraction rewrites
	// the same name as it reads further into the file.
	subtitleCacheControl = "public, max-age=3600"

	// maxRememberedSubtitles bounds the record of which subtitle files already
	// reached the bucket. The record lives as long as the process, and without
	// a ceiling it would grow for every room the server ever published.
	// Forgetting all of it costs one redundant upload per track still being
	// extracted, which is the cheaper failure.
	maxRememberedSubtitles = 4096
)

// Publisher moves a room's encoded output into the bucket and publishes the
// playlists that point at it.
//
// Segments go to the bucket and are served from the edge; playlists go to
// Redis and are served by the application. Splitting them that way is what
// lets any instance serve a room, and keeps the room's expiry check on the
// one request a viewer must make before playing anything.
type Publisher struct {
	store   *room.Store
	bucket  objectstore.Store
	baseURL string
	// interval is how often Run publishes. Tests shorten it.
	interval time.Duration

	// sentSubtitles digests the subtitle files already in the bucket, keyed by
	// the object key they landed on. Progressive extraction rewrites every
	// track's file on every tick whether or not its cues moved, so without this
	// a track that ran out of dialogue is uploaded again on each one.
	subsMu        sync.Mutex
	sentSubtitles map[string][sha256.Size]byte
}

func NewPublisher(store *room.Store, bucket objectstore.Store, mediaPublicURL string) *Publisher {
	return &Publisher{
		store:         store,
		bucket:        bucket,
		baseURL:       strings.TrimSuffix(mediaPublicURL, "/"),
		interval:      PublishInterval,
		sentSubtitles: make(map[string][sha256.Size]byte),
	}
}

// MediaPrefix is where one generation of a room's media lives.
//
// The generation is in the path because segment names repeat: swap the source
// and the next encode writes stream_1_000.m4s again. Those URLs are handed to
// the edge as immutable for a year, so reusing them would serve the previous
// video from cache with no way to correct it.
func MediaPrefix(roomID string, generation int) string {
	return "rooms/" + roomID + "/g" + strconv.Itoa(generation) + "/"
}

func hlsPrefix(roomID string, generation int) string { return MediaPrefix(roomID, generation) + "hls/" }
func subsPrefix(roomID string, generation int) string {
	return MediaPrefix(roomID, generation) + "subs/"
}

// Publish runs one pass: upload what the playlists reference, then republish
// the playlists themselves pointing at the bucket.
//
// patterns names the playlists this pass owns. The progressive preview and
// the final remux write into the same directory, and the final ladder must
// not become visible until its own pass says so.
func (p *Publisher) Publish(ctx context.Context, roomID, hlsDir string, patterns []string) error {
	bodies, err := readPlaylists(hlsDir, patterns)
	if err != nil {
		return err
	}
	if len(bodies) == 0 {
		return nil
	}
	generation, err := p.generation(ctx, roomID)
	if err != nil {
		return err
	}
	published, err := p.store.Published(ctx, roomID)
	if err != nil {
		return fmt.Errorf("load published objects: %w", err)
	}

	names := sortedKeys(bodies)
	// Objects are queued in playlist order, so the playable edge of the
	// playlist a viewer is currently watching moves before anything else.
	var pending []string
	for _, name := range names {
		for _, object := range playlistObjects(bodies[name]) {
			if _, done := published[object]; done {
				continue
			}
			pending = append(pending, object)
		}
	}

	var uploadErr error
	for len(pending) > 0 && uploadErr == nil {
		// Cancellation stops the pass between batches rather than during one:
		// an upload already streaming is left to finish, because a half-written
		// object reads back intact over the S3 API while the edge serves it
		// truncated, and no cache purge repairs that.
		if err := ctx.Err(); err != nil {
			uploadErr = err
			break
		}
		batch := pending[:min(publishBatchSize, len(pending))]
		pending = pending[len(batch):]

		landed, err := p.uploadBatch(ctx, roomID, generation, hlsDir, batch)
		uploadErr = err
		for _, object := range landed {
			published[object] = struct{}{}
		}
		if len(landed) == 0 {
			continue
		}
		// Recording and rendering after every batch is what makes the playable
		// edge advance during a pass instead of only at the end of one. A room
		// with thousands of segments queued would otherwise show nothing for as
		// long as the whole backlog takes.
		if err := p.commit(ctx, roomID, generation, bodies, names, published, landed); err != nil {
			return err
		}
		p.dropUploadedSegments(hlsDir, landed)
	}
	if uploadErr != nil {
		return uploadErr
	}
	// The playlists themselves grow even when every object they name is
	// already in the bucket, so the last word on what they cover is published
	// whether or not this pass moved any bytes.
	return p.commit(ctx, roomID, generation, bodies, names, published, nil)
}

// uploadBatch sends a batch of objects to the bucket at once and reports which
// of them landed. Uploading one at a time made the publisher the slowest part
// of the pipeline by a wide margin: an encode writing thirty segments a second
// queued all of them behind whichever single object was in flight.
func (p *Publisher) uploadBatch(ctx context.Context, roomID string, generation int,
	hlsDir string, objects []string) ([]string, error) {
	var (
		mu       sync.Mutex
		landed   []string
		firstErr error
	)
	slots := make(chan struct{}, uploadConcurrency)
	var wg sync.WaitGroup
	for _, object := range objects {
		wg.Add(1)
		go func(object string) {
			defer wg.Done()
			slots <- struct{}{}
			defer func() { <-slots }()
			err := p.putObject(ctx, hlsPrefix(roomID, generation)+object,
				filepath.Join(hlsDir, object), segmentContentType(object), immutableCacheControl)
			mu.Lock()
			defer mu.Unlock()
			switch {
			case errors.Is(err, os.ErrNotExist):
				// The playlist names it but the muxer has not finished renaming
				// it into place. Leaving it unpublished makes the rendered
				// playlist stop here, which is the whole point of truncation;
				// the next pass picks it up.
			case err != nil:
				if firstErr == nil {
					firstErr = err
				}
			default:
				landed = append(landed, object)
			}
		}(object)
	}
	wg.Wait()
	return landed, firstErr
}

// commit records what reached the bucket and republishes the playlists around
// it. Recording before rendering is what makes truncation honest: a playlist
// may only name an object this set already vouches for.
func (p *Publisher) commit(ctx context.Context, roomID string, generation int,
	bodies map[string][]byte, names []string, published map[string]struct{}, landed []string) error {
	// Bookkeeping outlives the cancellation that ended the pass, because a
	// record lost here is paid for again as a re-upload by the next one.
	commitCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), bookkeepingTimeout)
	defer cancel()
	if len(landed) > 0 {
		if err := p.store.MarkPublished(commitCtx, roomID, landed...); err != nil {
			return fmt.Errorf("record published objects: %w", err)
		}
	}
	rendered := make(map[string]string, len(bodies))
	for _, name := range names {
		if out, ok := p.renderPlaylist(roomID, generation, bodies[name], published); ok {
			rendered[name] = out
		}
	}
	if err := p.store.SetPlaylists(commitCtx, roomID, rendered); err != nil {
		return fmt.Errorf("publish playlists: %w", err)
	}
	return nil
}

// Run publishes on a tick until ctx ends, then makes one final pass so an
// encode that stopped between ticks still lands whole.
func (p *Publisher) Run(ctx context.Context, roomID, hlsDir string, patterns []string) {
	ticker := time.NewTicker(p.interval)
	defer ticker.Stop()
	failing := 0
	for {
		select {
		case <-ctx.Done():
			// The parent context is already dead, so the last pass gets its
			// own deadline rather than failing before it starts.
			finalCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
			defer cancel()
			if err := p.Publish(finalCtx, roomID, hlsDir, patterns); err != nil {
				slog.WarnContext(ctx, "final media publish failed", "room_id", roomID, "error", err)
			}
			return
		case <-ticker.C:
			err := p.Publish(ctx, roomID, hlsDir, patterns)
			if err != nil && ctx.Err() == nil && failing == 0 {
				// Only the start of a run of failures is logged. Giving up
				// here would freeze a preview at its last confirmed segment
				// over one blip, and nothing downstream would notice: this
				// loop is best effort, and the pass that decides whether the
				// room has media runs after the encode.
				slog.WarnContext(ctx, "media publish failing", "room_id", roomID, "error", err)
			}
			switch {
			case err != nil:
				failing++
			case failing > 0:
				slog.InfoContext(ctx, "media publish recovered",
					"room_id", roomID, "failed_attempts", failing)
				failing = 0
			}
		}
	}
}

// PublishSubtitles uploads every WebVTT file in subsDir whose content is not
// already in the bucket. Subtitle URLs are built by the client, so they carry
// a version query string of their own and do not need the published set.
func (p *Publisher) PublishSubtitles(ctx context.Context, roomID, subsDir string) error {
	generation, err := p.generation(ctx, roomID)
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(subsDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("list subtitles: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.EqualFold(filepath.Ext(entry.Name()), ".vtt") {
			continue
		}
		if err := p.putSubtitle(ctx, subsPrefix(roomID, generation)+entry.Name(),
			filepath.Join(subsDir, entry.Name())); err != nil {
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
func (p *Publisher) putSubtitle(ctx context.Context, key, path string) error {
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
		"text/vtt; charset=utf-8", subtitleCacheControl); err != nil {
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

func (p *Publisher) putObject(ctx context.Context, key, path, contentType, cacheControl string) error {
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err != nil {
		return fmt.Errorf("open %s for upload: %w", filepath.Base(path), err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return fmt.Errorf("size %s for upload: %w", filepath.Base(path), err)
	}
	// Detached from the caller's cancellation on purpose. Once bytes are
	// moving, the cheapest outcome is to let them land: an aborted PUT leaves
	// the bucket holding an object that passes an S3 read and is served
	// truncated from the edge, which is indistinguishable from working media
	// until a viewer's player stalls on it.
	uploadCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), uploadTimeout)
	defer cancel()
	return p.bucket.Put(uploadCtx, key, file, info.Size(), contentType, cacheControl)
}

// dropUploadedSegments reclaims disk for media segments now in the bucket.
//
// Init files stay: they are a handful of kilobytes, and the codec annotation
// pass reads the video init segment to write an HEVC label that ffmpeg cannot
// be trusted to render correctly.
func (p *Publisher) dropUploadedSegments(hlsDir string, uploaded []string) {
	for _, object := range uploaded {
		if !strings.HasSuffix(object, ".m4s") {
			continue
		}
		if err := os.Remove(filepath.Join(hlsDir, object)); err != nil && !errors.Is(err, os.ErrNotExist) {
			slog.Warn("remove uploaded segment failed", "segment", object, "error", err)
		}
	}
}

// renderPlaylist rewrites a playlist for delivery and reports whether it is
// worth publishing at all.
//
// A master playlist is returned unchanged: its URIs name variant playlists,
// which the application still serves. A media playlist gets bucket URLs and
// is cut at the last segment the bucket has confirmed.
func (p *Publisher) renderPlaylist(roomID string, generation int, body []byte,
	published map[string]struct{}) (string, bool) {
	if isMasterPlaylist(body) {
		return string(body), true
	}
	base := p.baseURL + "/" + hlsPrefix(roomID, generation)
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

// readPlaylists loads the playlists matching patterns, keyed by file name. A
// pattern matching nothing is not an error: the encode may not have written
// its first playlist yet.
func readPlaylists(hlsDir string, patterns []string) (map[string][]byte, error) {
	bodies := make(map[string][]byte)
	for _, pattern := range patterns {
		matches, err := filepath.Glob(filepath.Join(hlsDir, pattern))
		if err != nil {
			return nil, fmt.Errorf("match playlists %s: %w", pattern, err)
		}
		for _, match := range matches {
			body, err := os.ReadFile(match)
			if err != nil {
				if errors.Is(err, os.ErrNotExist) {
					continue
				}
				return nil, fmt.Errorf("read playlist %s: %w", filepath.Base(match), err)
			}
			if len(body) == 0 {
				continue
			}
			bodies[filepath.Base(match)] = body
		}
	}
	return bodies, nil
}

func segmentContentType(name string) string {
	if strings.HasSuffix(name, ".mp4") {
		return "video/mp4"
	}
	return "video/iso.segment"
}

func sortedKeys(m map[string][]byte) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}

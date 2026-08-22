package urlingest

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// resumeAttempts bounds how many times a broken stream is picked up again
	// without a single byte being stored. A slow origin stalls rather than
	// fails, so only a run that makes no progress counts against this.
	resumeAttempts = 5
	// resumeBackoff spaces out those retries.
	resumeBackoff = 3 * time.Second
	// tusVersion is the only protocol version the server speaks.
	tusVersion = "1.0.0"
)

// Job is one remote file to pull into one room.
type Job struct {
	RoomID   string
	URL      string
	FileName string
	// Size is what the caller announced. Zero means unknown, which is the
	// common case: a stream object carries a URL far more often than it
	// carries a byte count. An unknown size is asked of the origin instead.
	Size int64
}

// Hooks lets the ingest report into the rest of the server without depending
// on it. Both are optional.
type Hooks struct {
	// OnFailed reports an ingest that gave up, so the room can stop showing a
	// transfer that is not happening.
	OnFailed func(roomID string, err error)
	// OnDone reports one that finished.
	OnDone func(roomID string)
}

var (
	// ErrBusy reports that too many ingests are already running.
	ErrBusy = errors.New("too many url ingests in flight")
	// ErrNotVideo reports a source that answered with something other than a
	// video — an HTML error page, most likely.
	ErrNotVideo = errors.New("source did not return a video")
	// ErrTooLarge reports a source bigger than the size the room reserved.
	ErrTooLarge = errors.New("source is larger than the announced size")
	// ErrNoRange reports a source that ignored a Range request, which makes a
	// resumed transfer impossible.
	ErrNoRange = errors.New("source does not support resuming")
	// ErrUnknownSize reports a source that will not say how big it is. A tus
	// upload is created against a length, so there is nothing to create.
	ErrUnknownSize = errors.New("source did not report its size")
)

// Ingestor pulls remote files into rooms through the server's own tus
// endpoint, for the same reason the torrent ingestor does: the upload
// reservation, the progress ticks that start the preview, the completion
// hand-off and the sweeper all already exist on that path.
type Ingestor struct {
	uploadURL string
	client    *http.Client
	hooks     Hooks
	// check is CheckURL. A field for the same reason client is one: httptest
	// only speaks http on loopback, which the guard refuses by design. The
	// guard has its own tests; these are about the pump.
	check func(string) (*url.URL, error)
	// maxBytes is the room's ceiling, the same one the manual upload has. It
	// is enforced here because a job with an unknown size cannot be checked by
	// the route.
	maxBytes int64

	// backoff spaces out resumed streams. A field rather than a constant so
	// tests can exercise the stall path without waiting out real seconds.
	backoff time.Duration

	mu      sync.Mutex
	ctx     context.Context
	started bool
	running map[string]context.CancelFunc
	maxJobs int
}

// NewIngestor wires an ingestor to the tus endpoint of this same server.
// uploadURL is absolute and loopback.
func NewIngestor(uploadURL string, maxJobs int, maxBytes int64, hooks Hooks) *Ingestor {
	if maxJobs < 1 {
		maxJobs = 1
	}
	return &Ingestor{
		uploadURL: uploadURL,
		client:    SafeClient(0),
		hooks:     hooks,
		check:     CheckURL,
		maxBytes:  maxBytes,
		backoff:   resumeBackoff,
		running:   make(map[string]context.CancelFunc),
		maxJobs:   maxJobs,
	}
}

// Enabled reports whether url sources can be ingested at all.
func (i *Ingestor) Enabled() bool { return i != nil && i.uploadURL != "" }

// Start makes the ingestor accept jobs until ctx is cancelled.
func (i *Ingestor) Start(ctx context.Context) {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.ctx = ctx
	i.started = true
}

// Submit starts pulling job in the background. One room can only have one
// ingest, and starting a new one replaces whatever was running for it.
//
// The url is checked here rather than in the goroutine so that a caller who
// hands over a private address learns about it in the response.
func (i *Ingestor) Submit(job Job) error {
	if _, err := i.check(job.URL); err != nil {
		return err
	}
	if job.Size < 0 || (i.maxBytes > 0 && job.Size > i.maxBytes) {
		return fmt.Errorf("%w: announced size %d", ErrTooLarge, job.Size)
	}
	i.mu.Lock()
	if !i.started || i.ctx == nil || i.ctx.Err() != nil {
		i.mu.Unlock()
		return errors.New("ingestor not running")
	}
	if _, exists := i.running[job.RoomID]; !exists && len(i.running) >= i.maxJobs {
		i.mu.Unlock()
		return ErrBusy
	}
	if cancel, exists := i.running[job.RoomID]; exists {
		cancel()
	}
	jobCtx, cancel := context.WithCancel(i.ctx)
	i.running[job.RoomID] = cancel
	i.mu.Unlock()

	go func() {
		defer i.finish(job.RoomID)
		err := i.run(jobCtx, job)
		if err == nil {
			slog.Info("url ingest complete", "room_id", job.RoomID)
			if i.hooks.OnDone != nil {
				i.hooks.OnDone(job.RoomID)
			}
			return
		}
		if jobCtx.Err() != nil {
			slog.Info("url ingest stopped", "room_id", job.RoomID)
			return
		}
		slog.Error("url ingest failed", "room_id", job.RoomID, "error", redact(err))
		if i.hooks.OnFailed != nil {
			i.hooks.OnFailed(job.RoomID, err)
		}
	}()
	return nil
}

// Cancel stops the ingest feeding roomID, if any. Swapping a room's source
// calls it before the previous media is deleted.
func (i *Ingestor) Cancel(roomID string) {
	i.mu.Lock()
	cancel, ok := i.running[roomID]
	i.mu.Unlock()
	if ok {
		cancel()
	}
}

func (i *Ingestor) finish(roomID string) {
	i.mu.Lock()
	delete(i.running, roomID)
	i.mu.Unlock()
}

func (i *Ingestor) run(ctx context.Context, job Job) error {
	// The origin is asked how big the file is, always — never the caller.
	//
	// Taking the announced size on trust looks cheaper and is a data-loss bug:
	// with a chunked response there is no Content-Length to check it against,
	// and setting request.ContentLength makes the transport read exactly that
	// many bytes and stop. The PATCH completes, the job reports success, and
	// the room holds a film cut in half. An announced size smaller than the
	// truth is not hypothetical — a stale library or a plugin that guessed
	// hands one over.
	//
	// What the caller announced is kept as a ceiling: it is what the room
	// reserved, and a source bigger than that is refused.
	announced := job.Size
	size, err := i.probeSize(ctx, job)
	if err != nil {
		return err
	}
	job.Size = size
	if announced > 0 && size > announced {
		return fmt.Errorf("%w: source is %d bytes, %d were announced", ErrTooLarge, size, announced)
	}
	if i.maxBytes > 0 && job.Size > i.maxBytes {
		return fmt.Errorf("%w: %d bytes, ceiling is %d", ErrTooLarge, job.Size, i.maxBytes)
	}
	uploadURL, createErr := i.createUpload(ctx, job)
	if createErr != nil {
		return createErr
	}
	slog.Info("url ingest started", "room_id", job.RoomID, "bytes", job.Size)

	offset := int64(0)
	for attempt := 0; offset < job.Size; {
		written, err := i.pump(ctx, job, uploadURL, offset)
		if written < 0 {
			written = 0
		}
		offset += written
		if offset >= job.Size {
			break
		}
		// A source that hands back something other than a video, or more bytes
		// than the room reserved, will do it again on every retry.
		if errors.Is(err, ErrNotVideo) || errors.Is(err, ErrTooLarge) ||
			errors.Is(err, ErrNoRange) || errors.Is(err, ErrUnknownSize) {
			return err
		}
		if err == nil {
			// A body that ended early without an error still leaves bytes to
			// fetch; a fresh request picks up where the store did.
			err = io.ErrUnexpectedEOF
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if written > 0 {
			// Progress was made, so this is a hiccup rather than a broken
			// pipeline: keep going without spending an attempt.
			attempt = 0
		} else {
			attempt++
			if attempt >= resumeAttempts {
				return fmt.Errorf("url ingest stalled at %d/%d bytes: %w", offset, job.Size, err)
			}
		}
		slog.Warn("url ingest resuming",
			"room_id", job.RoomID, "offset", offset, "attempt", attempt, "error", redact(err))
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(i.backoff):
		}
	}
	return nil
}

// probeSize asks the origin how big the file is, with a one-byte range
// request. A HEAD would be tidier and is answered wrongly by enough origins
// that it is not worth the tidiness.
//
// The content type is checked here too, before createUpload: otherwise an HTML
// error page has already consumed the room's upload reservation by the time
// the job dies.
func (i *Ingestor) probeSize(ctx context.Context, job Job) (int64, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, job.URL, nil)
	if err != nil {
		return 0, fmt.Errorf("build probe request: %w", err)
	}
	request.Header.Set("Range", "bytes=0-0")
	response, err := i.client.Do(request)
	if err != nil {
		return 0, fmt.Errorf("probe source: %w", err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<16))
		response.Body.Close()
	}()
	if contentType := response.Header.Get("Content-Type"); contentType != "" && !videoContentType(contentType) {
		return 0, fmt.Errorf("%w: content-type %q", ErrNotVideo, contentType)
	}
	if response.StatusCode == http.StatusPartialContent {
		// "bytes 0-0/12345" — the total is what is after the slash.
		contentRange := response.Header.Get("Content-Range")
		if slash := strings.LastIndexByte(contentRange, '/'); slash >= 0 {
			if total, err := strconv.ParseInt(strings.TrimSpace(contentRange[slash+1:]), 10, 64); err == nil && total > 0 {
				return total, nil
			}
		}
	}
	if response.StatusCode == http.StatusOK && response.ContentLength > 0 {
		return response.ContentLength, nil
	}
	return 0, ErrUnknownSize
}

// fetch opens the source at offset and returns a body that refuses to hand
// over more than the room reserved.
func (i *Ingestor) fetch(ctx context.Context, job Job, offset int64) (io.ReadCloser, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, job.URL, nil)
	if err != nil {
		return nil, fmt.Errorf("build source request: %w", err)
	}
	if offset > 0 {
		request.Header.Set("Range", "bytes="+strconv.FormatInt(offset, 10)+"-")
	}
	response, err := i.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("fetch source: %w", err)
	}
	discard := func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<16))
		response.Body.Close()
	}
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusPartialContent {
		discard()
		return nil, fmt.Errorf("source answered %d", response.StatusCode)
	}
	if offset > 0 && response.StatusCode == http.StatusOK {
		// The origin ignored the Range and is sending the file from the start.
		// Writing that at this offset would corrupt the file silently.
		discard()
		return nil, ErrNoRange
	}
	if contentType := response.Header.Get("Content-Type"); contentType != "" && !videoContentType(contentType) {
		discard()
		return nil, fmt.Errorf("%w: content-type %q", ErrNotVideo, contentType)
	}
	if response.ContentLength >= 0 && offset+response.ContentLength > job.Size {
		discard()
		return nil, fmt.Errorf("%w: %d bytes from offset %d, room reserved %d",
			ErrTooLarge, response.ContentLength, offset, job.Size)
	}
	// One byte wider than the room reserved, on purpose. A chunked response
	// announces no length, so the Content-Length check above cannot fire;
	// cutting the body at the announced size would produce a complete PATCH,
	// an OnDone, and a truncated film in the room with no error anywhere. An
	// announced size smaller than the truth is not hypothetical — it is what a
	// stale library, or a plugin that guessed, hands over.
	return readCloser{
		Reader: &exactReader{inner: io.LimitReader(response.Body, job.Size-offset+1), limit: job.Size - offset},
		Closer: response.Body,
	}, nil
}

type readCloser struct {
	io.Reader
	io.Closer
}

// exactReader fails rather than truncating. It is handed one byte more than
// the room reserved; if that byte arrives, the source is longer than it said.
type exactReader struct {
	inner io.Reader
	limit int64
	read  int64
}

func (r *exactReader) Read(p []byte) (int, error) {
	n, err := r.inner.Read(p)
	r.read += int64(n)
	if r.read > r.limit {
		return n - int(r.read-r.limit), fmt.Errorf("%w: source is longer than the announced %d bytes", ErrTooLarge, r.limit)
	}
	return n, err
}

// videoContentType accepts what a media file is actually served as. Some
// origins hand back application/octet-stream for an .mkv, which is not wrong.
func videoContentType(value string) bool {
	media := strings.TrimSpace(strings.ToLower(value))
	if index := strings.IndexByte(media, ';'); index >= 0 {
		media = strings.TrimSpace(media[:index])
	}
	return strings.HasPrefix(media, "video/") || media == "application/octet-stream" ||
		media == "application/mp4" || media == "application/x-matroska"
}

// pump moves one stream of source bytes into one tus PATCH and reports how
// many bytes the server confirmed it stored.
func (i *Ingestor) pump(ctx context.Context, job Job, uploadURL string, offset int64) (int64, error) {
	body, err := i.fetch(ctx, job, offset)
	if err != nil {
		return 0, err
	}
	defer body.Close()

	request, err := http.NewRequestWithContext(ctx, http.MethodPatch, uploadURL, body)
	if err != nil {
		return 0, fmt.Errorf("build upload request: %w", err)
	}
	request.Header.Set("Tus-Resumable", tusVersion)
	request.Header.Set("Content-Type", "application/offset+octet-stream")
	request.Header.Set("Upload-Offset", strconv.FormatInt(offset, 10))
	// Declaring the length keeps the request out of chunked encoding and lets
	// the store detect a truncated stream instead of accepting it as the end.
	request.ContentLength = job.Size - offset

	response, err := i.client.Do(request)
	if err != nil {
		// The bytes the server did store are still there; ask it how far it got.
		stored, headErr := i.uploadOffset(ctx, uploadURL)
		if headErr != nil {
			return 0, errors.Join(fmt.Errorf("upload source bytes: %w", err), headErr)
		}
		return stored - offset, fmt.Errorf("upload source bytes: %w", err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<16))
		response.Body.Close()
	}()
	if response.StatusCode != http.StatusNoContent {
		detail, _ := io.ReadAll(io.LimitReader(response.Body, 1<<10))
		stored, headErr := i.uploadOffset(ctx, uploadURL)
		if headErr != nil {
			stored = offset
		}
		return stored - offset, fmt.Errorf("upload rejected (%d): %s",
			response.StatusCode, strings.TrimSpace(string(detail)))
	}
	next, err := strconv.ParseInt(response.Header.Get("Upload-Offset"), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("upload returned no offset: %w", err)
	}
	return next - offset, nil
}

func (i *Ingestor) createUpload(ctx context.Context, job Job) (string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, i.uploadURL, nil)
	if err != nil {
		return "", fmt.Errorf("build upload creation: %w", err)
	}
	request.Header.Set("Tus-Resumable", tusVersion)
	request.Header.Set("Upload-Length", strconv.FormatInt(job.Size, 10))
	request.Header.Set("Upload-Metadata", encodeMetadata(map[string]string{
		"roomID":   job.RoomID,
		"filename": job.FileName,
	}))
	response, err := i.client.Do(request)
	if err != nil {
		return "", fmt.Errorf("create upload: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		detail, _ := io.ReadAll(io.LimitReader(response.Body, 1<<10))
		return "", fmt.Errorf("create upload failed (%d): %s",
			response.StatusCode, strings.TrimSpace(string(detail)))
	}
	location := response.Header.Get("Location")
	if location == "" {
		return "", errors.New("create upload returned no location")
	}
	return resolveLocation(i.uploadURL, location), nil
}

func (i *Ingestor) uploadOffset(ctx context.Context, uploadURL string) (int64, error) {
	// The parent context may already be cancelled by the very failure that
	// brought us here, and the answer is still needed to resume later.
	headCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(headCtx, http.MethodHead, uploadURL, nil)
	if err != nil {
		return 0, fmt.Errorf("build offset request: %w", err)
	}
	request.Header.Set("Tus-Resumable", tusVersion)
	response, err := i.client.Do(request)
	if err != nil {
		return 0, fmt.Errorf("read upload offset: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("read upload offset failed (%d)", response.StatusCode)
	}
	offset, err := strconv.ParseInt(response.Header.Get("Upload-Offset"), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("parse upload offset: %w", err)
	}
	return offset, nil
}

// redact strips the query out of any url an error carries.
//
// A Plex part url carries X-Plex-Token in its query, and net/url errors quote
// the whole address. Logging that writes an account credential into the
// journal, and reporting it hands one to whoever sees the room's error.
func redact(err error) error {
	if err == nil {
		return nil
	}
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		if parsed, parseErr := url.Parse(urlErr.URL); parseErr == nil && parsed.RawQuery != "" {
			parsed.RawQuery = "redacted"
			return fmt.Errorf("%s %q: %w", urlErr.Op, parsed.String(), urlErr.Err)
		}
	}
	return err
}

// encodeMetadata and resolveLocation are the tus helpers, copied rather than
// exported from internal/torrent: they are six lines each, and making that
// package export them to this one couples two ingests that have nothing else
// in common.
func encodeMetadata(values map[string]string) string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	pairs := make([]string, 0, len(keys))
	for _, key := range keys {
		pairs = append(pairs, key+" "+base64.StdEncoding.EncodeToString([]byte(values[key])))
	}
	return strings.Join(pairs, ",")
}

func resolveLocation(endpoint, location string) string {
	base, err := url.Parse(endpoint)
	if err != nil {
		return location
	}
	resolved, err := base.Parse(location)
	if err != nil {
		return location
	}
	return resolved.String()
}

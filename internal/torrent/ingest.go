package torrent

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// resumeAttempts bounds how many times a broken stream is picked up again
	// without any byte being stored. A swarm with no seeder for the next piece
	// stalls rather than fails, so only a run that makes no progress at all
	// counts against this.
	resumeAttempts = 5
	// resumeBackoff spaces out those retries.
	resumeBackoff = 3 * time.Second
	// tusVersion is the only protocol version the server speaks.
	tusVersion = "1.0.0"
)

// Job is one torrent file to pull into one room.
type Job struct {
	RoomID    string
	SessionID string
	// Path identifies the file inside the torrent; FileName is its base name,
	// which is what the room displays and what gives the stored file its
	// extension.
	Path     string
	FileName string
	Size     int64
}

// Hooks lets the ingest report into the rest of the server without depending
// on it. All of them are optional.
type Hooks struct {
	// OnSubtitles receives the sibling subtitle files of the torrent as soon
	// as they have been fetched, so they can be published while the video is
	// still downloading.
	OnSubtitles func(roomID string, files []SideFile)
	// OnFailed reports an ingest that gave up, so the room can stop showing a
	// transfer that is not happening.
	OnFailed func(roomID string, err error)
}

// findFile locates one file of a torrent by the path the bridge reported.
func findFile(files []FileInfo, path string) (FileInfo, error) {
	for _, file := range files {
		if file.Path == path {
			return file, nil
		}
	}
	return FileInfo{}, fmt.Errorf("torrent has no file %q", path)
}

// SideFile is a small non-video file fetched whole from the torrent.
type SideFile struct {
	Name string
	Data []byte
}

// Ingestor pulls torrent files into rooms through the server's own tus
// endpoint.
//
// Going back out through tus rather than writing the file directly is what
// keeps this small: the upload reservation, the progress ticks that start the
// preview, the completion hand-off to the media queue and the sweeper that
// reclaims abandoned transfers are all the ones that already exist, and a
// torrent room reaches them by exactly the same path a browser upload does.
type Ingestor struct {
	bridge    *Bridge
	uploadURL string
	client    *http.Client
	hooks     Hooks

	// backoff spaces out resumed streams. A field rather than a constant so
	// tests can exercise the stall path without waiting out real seconds.
	backoff time.Duration

	mu       sync.Mutex
	ctx      context.Context
	started  bool
	running  map[string]context.CancelFunc
	maxJobs  int
	subtitle func(name string) bool
}

// NewIngestor wires an ingestor to a bridge and to the tus endpoint of this
// same server. uploadURL is absolute and loopback: the bytes never leave the
// host. isSubtitle decides which sibling files are worth fetching.
func NewIngestor(bridge *Bridge, uploadURL string, maxJobs int, isSubtitle func(string) bool, hooks Hooks) *Ingestor {
	if maxJobs < 1 {
		maxJobs = 1
	}
	return &Ingestor{
		bridge:    bridge,
		uploadURL: uploadURL,
		client:    &http.Client{},
		hooks:     hooks,
		backoff:   resumeBackoff,
		running:   make(map[string]context.CancelFunc),
		maxJobs:   maxJobs,
		subtitle:  isSubtitle,
	}
}

// Enabled reports whether torrents can be ingested server-side at all.
func (i *Ingestor) Enabled() bool { return i != nil && i.bridge != nil }

// Start makes the ingestor accept jobs until ctx is cancelled.
func (i *Ingestor) Start(ctx context.Context) {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.ctx = ctx
	i.started = true
}

// ErrBusy reports that too many ingests are already running.
var ErrBusy = errors.New("too many torrent ingests in flight")

// Submit starts pulling job in the background. One room can only have one
// ingest, and starting a new one replaces whatever was running for it.
func (i *Ingestor) Submit(job Job) error {
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
		if err := i.run(jobCtx, job); err != nil {
			if jobCtx.Err() != nil {
				slog.Info("torrent ingest stopped", "room_id", job.RoomID)
				return
			}
			slog.Error("torrent ingest failed", "room_id", job.RoomID, "error", err)
			if i.hooks.OnFailed != nil {
				i.hooks.OnFailed(job.RoomID, err)
			}
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
	// The size arrived from a browser, and the tus upload is created against
	// it: a wrong one produces an upload that can never complete. The bridge
	// is the authority on what the torrent actually holds, so ask it.
	files, err := i.bridge.Files(ctx, job.SessionID)
	if err != nil {
		return err
	}
	chosen, err := findFile(files, job.Path)
	if err != nil {
		return err
	}
	if chosen.Size != job.Size {
		return fmt.Errorf("torrent file %q is %d bytes, not %d", job.Path, chosen.Size, job.Size)
	}
	if err := i.bridge.Select(ctx, job.SessionID, job.Path); err != nil {
		return err
	}
	// The bridge session is this room's now, and nothing else will release it.
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		if err := i.bridge.Close(closeCtx, job.SessionID); err != nil {
			slog.Warn("close torrent session failed", "room_id", job.RoomID, "error", err)
		}
	}()

	// Subtitles are separate files and separate pieces, so fetching them does
	// not slow the video down and they can be published straight away.
	go i.fetchSubtitles(ctx, job, files)

	uploadURL, err := i.createUpload(ctx, job)
	if err != nil {
		return err
	}
	slog.Info("torrent ingest started", "room_id", job.RoomID, "bytes", job.Size)

	offset := int64(0)
	for attempt := 0; offset < job.Size; {
		written, err := i.pump(ctx, job, uploadURL, offset)
		offset += written
		if offset >= job.Size {
			break
		}
		if err == nil {
			// A body that ended early without an error still leaves bytes to
			// fetch; a fresh stream picks up where the store did.
			err = io.ErrUnexpectedEOF
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if written > 0 {
			// Progress was made, so this is a swarm hiccup rather than a
			// broken pipeline: keep going without spending an attempt.
			attempt = 0
		} else {
			attempt++
			if attempt >= resumeAttempts {
				return fmt.Errorf("torrent ingest stalled at %d/%d bytes: %w", offset, job.Size, err)
			}
		}
		slog.Warn("torrent ingest resuming",
			"room_id", job.RoomID, "offset", offset, "attempt", attempt, "error", err)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(i.backoff):
		}
	}
	slog.Info("torrent ingest complete", "room_id", job.RoomID, "bytes", offset)
	return nil
}

// pump moves one stream of torrent bytes into one tus PATCH and reports how
// many bytes the server confirmed it stored.
func (i *Ingestor) pump(ctx context.Context, job Job, uploadURL string, offset int64) (int64, error) {
	body, err := i.bridge.Stream(ctx, job.SessionID, offset)
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
			return 0, errors.Join(fmt.Errorf("upload torrent bytes: %w", err), headErr)
		}
		return stored - offset, fmt.Errorf("upload torrent bytes: %w", err)
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

// fetchSubtitles pulls the sibling subtitle files and hands them over. It is
// best effort throughout: the video is what the room is waiting for, and the
// media pipeline still extracts the tracks muxed into it.
func (i *Ingestor) fetchSubtitles(ctx context.Context, job Job, files []FileInfo) {
	if i.hooks.OnSubtitles == nil || i.subtitle == nil {
		return
	}
	var fetched []SideFile
	for _, file := range files {
		if !i.subtitle(file.Name) || file.Size <= 0 || file.Size > maxSideFileBytes {
			continue
		}
		data, err := i.bridge.ReadFile(ctx, job.SessionID, file.Path, file.Size)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			slog.Warn("fetch torrent subtitle failed",
				"room_id", job.RoomID, "file", file.Name, "error", err)
			continue
		}
		fetched = append(fetched, SideFile{Name: file.Name, Data: data})
	}
	if len(fetched) == 0 || ctx.Err() != nil {
		return
	}
	i.hooks.OnSubtitles(job.RoomID, fetched)
}

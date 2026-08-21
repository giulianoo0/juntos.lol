// Package upload wires tusd resumable uploads into the room lifecycle.
package upload

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"

	gonanoid "github.com/matoous/go-nanoid/v2"
	"github.com/tus/tusd/v2/pkg/filestore"
	tusd "github.com/tus/tusd/v2/pkg/handler"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/metrics"
	"github.com/giulianoo0/ss/internal/room"
)

// Callbacks are the pipeline hooks an upload drives. All are optional.
type Callbacks struct {
	// OnComplete fires once the finished upload has been moved into the room
	// directory as original.{ext}.
	OnComplete func(roomID string)
	// OnStreamStart is offered on every progress tick past cfg.StreamStartMB,
	// so a deduplicating progressive queue can begin, or retry after
	// backpressure. size is the upload's declared total.
	OnStreamStart func(roomID, srcPath string, size int64)
	// OnTerminate fires for an upload abandoned before completion.
	OnTerminate func(roomID string)
	// OnProgress reports every progress tick, whoever is sending the bytes.
	// It is what lets a room show a transfer it is not itself performing:
	// other viewers, and any viewer at all when the server is the uploader.
	OnProgress func(roomID string, received, total int64)
}

// NewTusHandler builds a tusd handler storing in-progress uploads under
// {DataDir}/tus-incoming. Uploads must carry a roomID metadata entry pointing
// to an existing room still in "uploading" status. Once an upload completes,
// the file is moved to {DataDir}/rooms/{roomID}/original.{ext}.
func NewTusHandler(cfg config.Config, store *room.Store, callbacks Callbacks) (http.Handler, error) {
	incoming := filepath.Join(cfg.DataDir, "tus-incoming")
	if err := os.MkdirAll(incoming, 0o755); err != nil {
		return nil, err
	}

	received := newReceivedBytes()
	fs := filestore.New(incoming)
	composer := tusd.NewStoreComposer()
	fs.UseIn(composer)

	handler, err := tusd.NewHandler(tusd.Config{
		BasePath:                "/api/upload/",
		StoreComposer:           composer,
		MaxSize:                 cfg.MaxUploadMB << 20,
		RespectForwardedHeaders: true,
		NotifyCompleteUploads:   true,
		NotifyTerminatedUploads: true,
		NotifyUploadProgress:    true,
		UploadProgressInterval:  500 * time.Millisecond,
		PreUploadCreateCallback: func(hook tusd.HookEvent) (tusd.HTTPResponse, tusd.FileInfoChanges, error) {
			roomID := hook.Upload.MetaData["roomID"]
			uploadID, err := gonanoid.New(32)
			if err != nil {
				return tusd.HTTPResponse{}, tusd.FileInfoChanges{},
					tusd.NewError("ERR_UPLOAD_CREATE", "could not create upload", http.StatusInternalServerError)
			}
			ctx := hook.Context
			if ctx == nil {
				ctx = context.Background()
			}
			if err := store.ReserveUpload(ctx, roomID, uploadID, time.Now()); err != nil {
				if errors.Is(err, room.ErrUploadReserved) {
					return tusd.HTTPResponse{}, tusd.FileInfoChanges{},
						tusd.NewError("ERR_UPLOAD_ALREADY_EXISTS", "room already has an upload", http.StatusConflict)
				}
				if !errors.Is(err, room.ErrUploadNotAllowed) {
					slog.Error("upload: reserve upload", "room", roomID, "err", err)
					return tusd.HTTPResponse{}, tusd.FileInfoChanges{},
						tusd.NewError("ERR_UPLOAD_CREATE", "could not create upload", http.StatusInternalServerError)
				}
				return tusd.HTTPResponse{}, tusd.FileInfoChanges{},
					tusd.NewError("ERR_UPLOAD_REJECTED", "room is not accepting uploads", http.StatusForbidden)
			}
			metrics.UploadsInFlight.Inc()
			return tusd.HTTPResponse{}, tusd.FileInfoChanges{ID: uploadID}, nil
		},
	})
	if err != nil {
		return nil, err
	}

	go func() {
		for ev := range handler.CompleteUploads {
			roomID := ev.Upload.MetaData["roomID"]
			metrics.UploadBytesReceived.Add(float64(received.settle(ev.Upload.ID, ev.Upload.Size)))
			metrics.UploadsInFlight.Dec()
			metrics.Uploads.WithLabelValues(metrics.UploadCompleted).Inc()
			if err := moveCompleted(cfg, store, roomID, ev.Upload.Storage[filestore.StorageKeyPath]); err != nil {
				slog.Error("upload: move completed upload", "room", roomID, "err", err)
				continue
			}
			invokeCompleteCallback(callbacks.OnComplete, roomID)
		}
	}()

	go func() {
		threshold := cfg.StreamStartMB << 20
		for ev := range handler.UploadProgress {
			roomID := ev.Upload.MetaData["roomID"]
			metrics.UploadBytesReceived.Add(float64(received.advance(ev.Upload.ID, ev.Upload.Offset)))
			if roomID == "" {
				continue
			}
			invokeProgressCallback(callbacks.OnProgress, roomID, ev.Upload.Offset, ev.Upload.Size)
			// Completion moves the file and fires OnComplete; only partial
			// progress past the threshold starts the preview.
			if ev.Upload.Offset < threshold || ev.Upload.Offset >= ev.Upload.Size {
				continue
			}
			srcPath := ev.Upload.Storage[filestore.StorageKeyPath]
			if srcPath == "" {
				srcPath = filepath.Join(incoming, ev.Upload.ID)
			}
			invokeStreamStartCallback(callbacks.OnStreamStart, roomID, srcPath, ev.Upload.Size)
		}
	}()

	go func() {
		for ev := range handler.TerminatedUploads {
			roomID := ev.Upload.MetaData["roomID"]
			// The bytes an abandoned upload did receive were still received,
			// so they are counted before the account is closed; what is lost
			// is the file, not the bandwidth that paid for it.
			metrics.UploadBytesReceived.Add(float64(received.settle(ev.Upload.ID, ev.Upload.Offset)))
			metrics.UploadsInFlight.Dec()
			metrics.Uploads.WithLabelValues(metrics.UploadTerminated).Inc()
			invokeTerminateCallback(callbacks.OnTerminate, roomID)
			if roomID == "" {
				continue
			}
			if err := store.ReleaseUpload(context.Background(), roomID, ev.Upload.ID); err != nil {
				slog.Error("upload: release terminated upload", "room", roomID, "err", err)
			}
			if err := os.RemoveAll(filepath.Join(cfg.DataDir, "rooms", roomID)); err != nil {
				slog.Error("upload: remove room dir after abort", "room", roomID, "err", err)
			}
		}
	}()

	return handler, nil
}

// moveCompleted moves src into the room directory as original.{ext}, using the
// room's file name for the extension. If the room is gone, it removes src so a
// completion racing expiry cannot retain media outside the room lifecycle.
func moveCompleted(cfg config.Config, store *room.Store, roomID, src string) error {
	if err := validateTusSource(cfg.DataDir, src); err != nil {
		return err
	}
	r, err := store.Get(context.Background(), roomID)
	if err != nil {
		return errors.Join(fmt.Errorf("get room: %w", err), removeTusArtifacts(src))
	}
	dir := filepath.Join(cfg.DataDir, "rooms", roomID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	dst := filepath.Join(dir, "original"+filepath.Ext(r.FileName))
	if err := os.Rename(src, dst); err != nil {
		return fmt.Errorf("move completed upload: %w", err)
	}
	// The filestore leaves a {id}.info sidecar behind; drop it.
	if err := os.Remove(src + ".info"); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove upload metadata: %w", err)
	}
	return nil
}

func validateTusSource(dataDir, src string) error {
	base := filepath.Join(dataDir, "tus-incoming")
	rel, err := filepath.Rel(base, src)
	if err != nil || rel == "." || !filepath.IsLocal(rel) {
		return fmt.Errorf("invalid tus source path %q", src)
	}
	return nil
}

func removeTusArtifacts(src string) error {
	var errs []error
	for _, path := range []string{src, src + ".info"} {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			errs = append(errs, fmt.Errorf("remove %s: %w", path, err))
		}
	}
	return errors.Join(errs...)
}

func invokeCompleteCallback(onComplete func(string), roomID string) {
	if onComplete == nil {
		return
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			slog.Error("upload: completion callback panicked", "room", roomID, "panic", recovered)
		}
	}()
	onComplete(roomID)
}

func invokeStreamStartCallback(onStreamStart func(string, string, int64), roomID, srcPath string, size int64) {
	if onStreamStart == nil {
		return
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			slog.Error("upload: stream start callback panicked", "room", roomID, "panic", recovered)
		}
	}()
	onStreamStart(roomID, srcPath, size)
}

func invokeProgressCallback(onProgress func(string, int64, int64), roomID string, received, total int64) {
	if onProgress == nil {
		return
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			slog.Error("upload: progress callback panicked", "room", roomID, "panic", recovered)
		}
	}()
	onProgress(roomID, received, total)
}

func invokeTerminateCallback(onTerminate func(string), roomID string) {
	if onTerminate == nil {
		return
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			slog.Error("upload: termination callback panicked", "room", roomID, "panic", recovered)
		}
	}()
	onTerminate(roomID)
}

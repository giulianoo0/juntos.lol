// Package upload wires tusd resumable uploads into the room lifecycle.
package upload

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"

	"github.com/tus/tusd/v2/pkg/filestore"
	tusd "github.com/tus/tusd/v2/pkg/handler"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
)

// NewTusHandler builds a tusd handler storing in-progress uploads under
// {DataDir}/tus-incoming. Uploads must carry a roomID metadata entry pointing
// to an existing room still in "uploading" status. Once an upload completes,
// the file is moved to {DataDir}/rooms/{roomID}/original.{ext} and
// onComplete(roomID) fires. Terminated uploads remove the room directory.
func NewTusHandler(cfg config.Config, store *room.Store, onComplete func(roomID string)) (http.Handler, error) {
	incoming := filepath.Join(cfg.DataDir, "tus-incoming")
	if err := os.MkdirAll(incoming, 0o755); err != nil {
		return nil, err
	}

	fs := filestore.New(incoming)
	composer := tusd.NewStoreComposer()
	fs.UseIn(composer)

	handler, err := tusd.NewHandler(tusd.Config{
		BasePath:                "/api/upload/",
		StoreComposer:           composer,
		MaxSize:                 cfg.MaxUploadMB << 20,
		NotifyCompleteUploads:   true,
		NotifyTerminatedUploads: true,
		PreUploadCreateCallback: func(hook tusd.HookEvent) (tusd.HTTPResponse, tusd.FileInfoChanges, error) {
			roomID := hook.Upload.MetaData["roomID"]
			r, err := store.Get(context.Background(), roomID)
			if err != nil || r.Status != "uploading" {
				return tusd.HTTPResponse{}, tusd.FileInfoChanges{},
					tusd.NewError("ERR_UPLOAD_REJECTED", "room is not accepting uploads", http.StatusForbidden)
			}
			return tusd.HTTPResponse{}, tusd.FileInfoChanges{}, nil
		},
	})
	if err != nil {
		return nil, err
	}

	go func() {
		for ev := range handler.CompleteUploads {
			roomID := ev.Upload.MetaData["roomID"]
			if err := moveCompleted(cfg, store, ev); err != nil {
				slog.Error("upload: move completed upload", "room", roomID, "err", err)
				continue
			}
			onComplete(roomID)
		}
	}()

	go func() {
		for ev := range handler.TerminatedUploads {
			roomID := ev.Upload.MetaData["roomID"]
			if roomID == "" {
				continue
			}
			if err := os.RemoveAll(filepath.Join(cfg.DataDir, "rooms", roomID)); err != nil {
				slog.Error("upload: remove room dir after abort", "room", roomID, "err", err)
			}
		}
	}()

	return handler, nil
}

// moveCompleted moves the finished upload file into the room directory as
// original.{ext}, using the room's file name for the extension.
func moveCompleted(cfg config.Config, store *room.Store, ev tusd.HookEvent) error {
	roomID := ev.Upload.MetaData["roomID"]
	r, err := store.Get(context.Background(), roomID)
	if err != nil {
		return err
	}
	src := ev.Upload.Storage[filestore.StorageKeyPath]
	dir := filepath.Join(cfg.DataDir, "rooms", roomID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	dst := filepath.Join(dir, "original"+filepath.Ext(r.FileName))
	if err := os.Rename(src, dst); err != nil {
		return err
	}
	// The filestore leaves a {id}.info sidecar behind; drop it.
	_ = os.Remove(src + ".info")
	return nil
}

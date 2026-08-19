// Package torrent pulls a selected torrent file straight into a room's
// upload, so the bytes never travel out to a browser and back.
package torrent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// maxSideFileBytes mirrors the bridge's own cap on a whole-file read. Sibling
// subtitle files are orders of magnitude below it.
const maxSideFileBytes = 8 << 20

// Bridge is an HTTP client for the torrent bridge's private API. The base URL
// is the bridge itself, not the public proxy: the stream endpoint is
// deliberately not reachable from outside.
type Bridge struct {
	baseURL string
	client  *http.Client
}

// NewBridge returns a client for the bridge at baseURL, or nil when no bridge
// is configured.
func NewBridge(baseURL string) *Bridge {
	baseURL = strings.TrimSuffix(baseURL, "/")
	if baseURL == "" {
		return nil
	}
	if _, err := url.Parse(baseURL); err != nil {
		return nil
	}
	// No client timeout: a stream call stays open for the length of the
	// download. Cancellation is the request context's job.
	return &Bridge{baseURL: baseURL, client: &http.Client{}}
}

// FileInfo is one file of an open torrent.
type FileInfo struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Size int64  `json:"size"`
	Type string `json:"type"`
}

type sessionInfo struct {
	Name  string     `json:"name"`
	Files []FileInfo `json:"files"`
}

func (b *Bridge) post(ctx context.Context, path string, body any) (*http.Response, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("encode bridge request: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, b.baseURL+path, bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("build bridge request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := b.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("call bridge %s: %w", path, err)
	}
	if response.StatusCode != http.StatusOK {
		detail, _ := io.ReadAll(io.LimitReader(response.Body, 1<<10))
		response.Body.Close()
		return nil, fmt.Errorf("bridge %s failed (%d): %s", path, response.StatusCode, strings.TrimSpace(string(detail)))
	}
	return response, nil
}

func (b *Bridge) postJSON(ctx context.Context, path string, body, out any) error {
	response, err := b.post(ctx, path, body)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if out == nil {
		return nil
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(out); err != nil {
		return fmt.Errorf("decode bridge %s reply: %w", path, err)
	}
	return nil
}

// Select points a bridge session at one file of its torrent.
func (b *Bridge) Select(ctx context.Context, sessionID, path string) error {
	return b.postJSON(ctx, "/api/torrent-bridge/select",
		map[string]any{"id": sessionID, "path": path}, nil)
}

// Stream opens the selected file from start to its end as one response body.
// The caller must close it; doing so releases the swarm selection behind it.
func (b *Bridge) Stream(ctx context.Context, sessionID string, start int64) (io.ReadCloser, error) {
	response, err := b.post(ctx, "/api/torrent-bridge/stream",
		map[string]any{"id": sessionID, "start": start})
	if err != nil {
		return nil, err
	}
	return response.Body, nil
}

// ReadFile fetches a whole sibling file, used for the subtitle files shipped
// next to the video. It never disturbs the session's selection.
func (b *Bridge) ReadFile(ctx context.Context, sessionID, path string, size int64) ([]byte, error) {
	if size <= 0 || size > maxSideFileBytes {
		return nil, fmt.Errorf("side file %q has unusable size %d", path, size)
	}
	response, err := b.post(ctx, "/api/torrent-bridge/read-file",
		map[string]any{"id": sessionID, "path": path, "start": 0, "end": size - 1})
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	return io.ReadAll(io.LimitReader(response.Body, maxSideFileBytes))
}

// Files lists the files of the torrent behind a session, without changing it.
func (b *Bridge) Files(ctx context.Context, sessionID string) ([]FileInfo, error) {
	var info sessionInfo
	if err := b.postJSON(ctx, "/api/torrent-bridge/files", map[string]any{"id": sessionID}, &info); err != nil {
		return nil, err
	}
	return info.Files, nil
}

// Close releases a bridge session and, with it, the torrent it held.
func (b *Bridge) Close(ctx context.Context, sessionID string) error {
	return b.postJSON(ctx, "/api/torrent-bridge/close", map[string]any{"id": sessionID}, nil)
}

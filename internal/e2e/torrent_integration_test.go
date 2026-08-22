//go:build integration

// Package e2e exercises the whole media path in one process: the HTTP API,
// the tus store, the server-side torrent ingest and the ffmpeg pipeline.
package e2e

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/httpapi"
	"github.com/giulianoo0/ss/internal/media"
	"github.com/giulianoo0/ss/internal/objectstore"
	"github.com/giulianoo0/ss/internal/room"
	"github.com/giulianoo0/ss/internal/torrent"
	"github.com/giulianoo0/ss/internal/upload"
)

// TestTorrentPlaysBeforeItFinishesDownloading is the whole point of the
// server-side ingest, end to end: a room fed by a slow "swarm" becomes
// playable while most of the file is still on its way.
//
// It runs the real pipeline — tus, the growing-file feeder, ffmpeg — against a
// bridge that hands over a real video at a throttled rate.
func TestTorrentPlaysBeforeItFinishesDownloading(t *testing.T) {
	requireFFmpeg(t)

	video := makeTestVideo(t, 40)
	info, err := os.Stat(video)
	require.NoError(t, err)
	content, err := os.ReadFile(video)
	require.NoError(t, err)

	// A rate that makes the whole file take several seconds, so "ready before
	// the last byte" is a real claim and not a race that happened to pass.
	bridge := newThrottledBridge(content, len(content)/8, "movie.mkv")
	bridgeServer := httptest.NewServer(bridge)
	t.Cleanup(bridgeServer.Close)

	server := startServer(t, bridgeServer.URL)
	roomID := server.createRoom(t, "movie.mkv")

	server.post(t, "/api/rooms/"+roomID+"/torrent", map[string]any{
		"sessionId": "session-1",
		"path":      "movie.mkv",
		"fileName":  "movie.mkv",
		"size":      info.Size(),
	}, http.StatusAccepted)

	// Ready is what lets the player appear at all.
	var readyAt int64
	require.Eventually(t, func() bool {
		stored, err := server.store.Get(t.Context(), roomID)
		if err != nil || stored.Status != "ready" {
			return false
		}
		readyAt = stored.Preparation.ReceivedBytes
		return true
	}, 90*time.Second, 250*time.Millisecond, "room never became playable")

	require.Less(t, readyAt, info.Size(),
		"the room only became playable once the whole file had arrived, which is the bug this exists to fix")
	t.Logf("playable after %d of %d bytes (%.0f%%)",
		readyAt, info.Size(), float64(readyAt)/float64(info.Size())*100)

	// The bytes were pulled once, sequentially, by the server.
	require.Equal(t, int32(1), bridge.streams.Load())

	// And the transfer still runs to completion behind the preview.
	require.Eventually(t, func() bool {
		_, err := os.Stat(filepath.Join(server.dataDir, "rooms", roomID, "original.mkv"))
		return err == nil
	}, 90*time.Second, 250*time.Millisecond, "the full file never landed")
}

func TestTorrentSourceThatCannotBePreviewedSaysSo(t *testing.T) {
	requireFFmpeg(t)

	// An MP4 written with its index after the media: the case that used to
	// leave a room preparing in silence until the download finished.
	video := makeTrailingMoovVideo(t, 20)
	info, err := os.Stat(video)
	require.NoError(t, err)
	content, err := os.ReadFile(video)
	require.NoError(t, err)

	bridge := newThrottledBridge(content, len(content)/10, "movie.mp4")
	bridgeServer := httptest.NewServer(bridge)
	t.Cleanup(bridgeServer.Close)

	server := startServer(t, bridgeServer.URL)
	roomID := server.createRoom(t, "movie.mp4")
	server.post(t, "/api/rooms/"+roomID+"/torrent", map[string]any{
		"sessionId": "session-1", "path": "movie.mp4",
		"fileName": "movie.mp4", "size": info.Size(),
	}, http.StatusAccepted)

	require.Eventually(t, func() bool {
		stored, err := server.store.Get(t.Context(), roomID)
		return err == nil && stored.Preparation.PreviewPhase == room.PreviewUnavailable
	}, 60*time.Second, 250*time.Millisecond,
		"the room never admitted it could not be previewed")

	// It still plays in the end, from the final remux.
	require.Eventually(t, func() bool {
		stored, err := server.store.Get(t.Context(), roomID)
		return err == nil && stored.Status == "ready"
	}, 90*time.Second, 250*time.Millisecond, "the room never became playable at all")
}

// --- harness ---

func requireFFmpeg(t *testing.T) {
	t.Helper()
	for _, binary := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(binary); err != nil {
			t.Skipf("%s not installed", binary)
		}
	}
}

func makeTestVideo(t *testing.T, seconds int) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "source.mkv")
	// A high bitrate keeps the file big enough that a preview genuinely
	// precedes the last byte, and a short GOP keeps segments cuttable.
	run(t, "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", fmt.Sprintf("testsrc=size=640x480:rate=25:duration=%d", seconds),
		"-f", "lavfi", "-i", fmt.Sprintf("sine=frequency=440:duration=%d", seconds),
		"-c:v", "libx264", "-preset", "ultrafast", "-g", "25", "-b:v", "2M",
		"-c:a", "aac", "-shortest", path)
	return path
}

func makeTrailingMoovVideo(t *testing.T, seconds int) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "source.mp4")
	// Without -movflags +faststart, ffmpeg writes moov last, which is the
	// layout that has no playable prefix.
	run(t, "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", fmt.Sprintf("testsrc=size=640x480:rate=25:duration=%d", seconds),
		"-c:v", "libx264", "-preset", "ultrafast", "-g", "25", "-b:v", "2M", path)
	return path
}

func run(t *testing.T, name string, args ...string) {
	t.Helper()
	output, err := exec.Command(name, args...).CombinedOutput()
	require.NoError(t, err, string(output))
}

// throttledBridge serves a file the way a swarm would: steadily, and slower
// than the pipeline can consume it.
type throttledBridge struct {
	content        []byte
	bytesPerSecond int
	streams        atomic.Int32
	files          []torrent.FileInfo
	sideFiles      map[string][]byte
}

func newThrottledBridge(content []byte, bytesPerSecond int, path string) *throttledBridge {
	if bytesPerSecond < 1 {
		bytesPerSecond = 1
	}
	return &throttledBridge{
		content:        content,
		bytesPerSecond: bytesPerSecond,
		// The ingest verifies the chosen file against this listing before it
		// creates an upload, so a bridge that serves a file has to list it.
		files: []torrent.FileInfo{{Name: path, Path: path, Size: int64(len(content))}},
	}
}

func (b *throttledBridge) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)

	switch {
	case strings.HasSuffix(r.URL.Path, "/stream"):
		b.streams.Add(1)
		start := 0
		if raw, ok := body["start"].(float64); ok {
			start = int(raw)
		}
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		// One tenth of a second's worth per write, so the growing file is fed
		// the way an actual transfer feeds it.
		step := max(b.bytesPerSecond/10, 1)
		for offset := start; offset < len(b.content); offset += step {
			end := min(offset+step, len(b.content))
			if _, err := w.Write(b.content[offset:end]); err != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
			select {
			case <-r.Context().Done():
				return
			case <-time.After(100 * time.Millisecond):
			}
		}
	case strings.HasSuffix(r.URL.Path, "/files"):
		_ = json.NewEncoder(w).Encode(map[string]any{"name": "t", "files": b.files})
	case strings.HasSuffix(r.URL.Path, "/read-file"):
		path, _ := body["path"].(string)
		data, ok := b.sideFiles[path]
		if !ok {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		_, _ = w.Write(data)
	default:
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	}
}

// testServer is main.go's wiring, assembled for a test.
type testServer struct {
	baseURL string
	store   *room.Store
	dataDir string
}

func startServer(t *testing.T, bridgeURL string) *testServer {
	t.Helper()
	gin.SetMode(gin.TestMode)

	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })
	store := room.NewStore(rdb, 5*time.Hour)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	port := listener.Addr().(*net.TCPAddr).Port

	cfg := config.Config{
		DataDir: t.TempDir(), MaxUploadMB: 1024, RoomTTLHours: 5,
		StreamStartMB: 1, FFmpegJobs: 2, Port: port, TorrentBridgeURL: bridgeURL,
	}

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	// Media leaves the process for a bucket now, so the whole path only runs
	// end to end with somewhere to put it.
	cfg.MediaPublicURL = "https://media.example.test"
	publisher := media.NewPublisher(store, objectstore.NewFake(), cfg.MediaPublicURL)

	queue := media.NewQueue(cfg.FFmpegJobs, store, cfg.DataDir, publisher, func(string) {}, nil)
	queue.Start(ctx)
	progressive := media.NewProgressive(cfg.FFmpegJobs, store, cfg.DataDir, publisher,
		cfg.StreamStartMB<<20, func(string) {}, func(string) {}, nil)
	progressive.Start(ctx)

	ingestor := torrent.NewIngestor(torrent.NewBridge(bridgeURL),
		fmt.Sprintf("http://127.0.0.1:%d/api/upload/", port), 2, media.IsSubtitleFileName,
		torrent.Hooks{OnSubtitles: func(roomID string, files []torrent.SideFile) {
			payload := make(map[string][]byte, len(files))
			for _, file := range files {
				payload[file.Name] = file.Data
			}
			subsDir := filepath.Join(cfg.DataDir, "rooms", roomID, "subs")
			converted, err := media.ConvertSideSubtitles(ctx, subsDir, payload)
			if err != nil || len(converted) == 0 {
				return
			}
			tracks, err := media.StoreExternalSubtitles(subsDir, converted)
			if err != nil {
				return
			}
			_ = store.SetClientSubtitles(ctx, roomID, tracks, false)
		}})
	ingestor.Start(ctx)

	engine := httpapi.NewServer(cfg, store, nil, httpapi.WithTorrentIngestor(ingestor))
	tusHandler, err := upload.NewTusHandler(cfg, store, upload.Callbacks{
		OnComplete: func(roomID string) {
			// Mirrors production wiring: the preview drains to the end of the
			// file instead of being cancelled when the upload completes.
			progressive.Complete(roomID)
			queue.Submit(roomID)
		},
		OnStreamStart: progressive.Submit,
		OnProgress: func(roomID string, received, total int64) {
			_ = store.SetIngestProgress(context.Background(), roomID, received, total)
		},
	})
	require.NoError(t, err)
	engine.Any("/api/upload", gin.WrapH(http.StripPrefix("/api/upload", tusHandler)))
	engine.Any("/api/upload/*path", gin.WrapH(http.StripPrefix("/api/upload", tusHandler)))

	httpServer := &http.Server{Handler: engine}
	go func() { _ = httpServer.Serve(listener) }()
	t.Cleanup(func() { _ = httpServer.Close() })

	return &testServer{
		baseURL: fmt.Sprintf("http://127.0.0.1:%d", port),
		store:   store,
		dataDir: cfg.DataDir,
	}
}

func (s *testServer) post(t *testing.T, path string, body any, wantStatus int) map[string]any {
	t.Helper()
	payload, err := json.Marshal(body)
	require.NoError(t, err)
	response, err := http.Post(s.baseURL+path, "application/json", strings.NewReader(string(payload)))
	require.NoError(t, err)
	defer response.Body.Close()
	require.Equal(t, wantStatus, response.StatusCode)
	var decoded map[string]any
	_ = json.NewDecoder(response.Body).Decode(&decoded)
	return decoded
}

func (s *testServer) createRoom(t *testing.T, fileName string) string {
	t.Helper()
	created := s.post(t, "/api/rooms",
		map[string]any{"fileName": fileName, "nickname": "tester"}, http.StatusCreated)
	id, _ := created["id"].(string)
	require.NotEmpty(t, id)
	return id
}

const sidecarSRT = `1
00:00:01,000 --> 00:00:03,000
Legenda que veio junto
`

// TestTorrentKeepsEveryAudioAndSubtitleTrack checks the two things a viewer
// picks from the player menus survive the server-side ingest: every audio
// track the source carries, and both kinds of subtitle — the ones muxed into
// the container and the ones shipped beside it.
func TestTorrentKeepsEveryAudioAndSubtitleTrack(t *testing.T) {
	requireFFmpeg(t)

	video := makeMultiTrackVideo(t, 12)
	info, err := os.Stat(video)
	require.NoError(t, err)
	content, err := os.ReadFile(video)
	require.NoError(t, err)

	bridge := newThrottledBridge(content, len(content)/12, "movie.mkv")
	bridge.files = append(bridge.files,
		torrent.FileInfo{Name: "movie.eng.srt", Path: "Subs/movie.eng.srt", Size: int64(len(sidecarSRT))})
	bridge.sideFiles = map[string][]byte{"Subs/movie.eng.srt": []byte(sidecarSRT)}
	bridgeServer := httptest.NewServer(bridge)
	t.Cleanup(bridgeServer.Close)

	server := startServer(t, bridgeServer.URL)
	roomID := server.createRoom(t, "movie.mkv")
	server.post(t, "/api/rooms/"+roomID+"/torrent", map[string]any{
		"sessionId": "session-1", "path": "movie.mkv",
		"fileName": "movie.mkv", "size": info.Size(),
	}, http.StatusAccepted)

	// Subtitles are usable while the video is still arriving. This is what the
	// server-side ingest took away when the bytes stopped passing through a
	// browser, and what the progressive extraction gives back.
	require.Eventually(t, func() bool {
		stored, err := server.store.Get(t.Context(), roomID)
		return err == nil && len(stored.SubtitleTracks) > 0 && stored.Status != "ready"
	}, 30*time.Second, 200*time.Millisecond,
		"no subtitle was usable before the video finished downloading")

	require.Eventually(t, func() bool {
		stored, err := server.store.Get(t.Context(), roomID)
		return err == nil && stored.Status == "ready" && len(stored.AudioTracks) > 0
	}, 120*time.Second, 250*time.Millisecond, "the room never finished")

	stored, err := server.store.Get(t.Context(), roomID)
	require.NoError(t, err)

	// Both audio tracks are offered, with their languages intact.
	require.Len(t, stored.AudioTracks, 2)
	require.Equal(t, []string{"eng", "jpn"},
		[]string{stored.AudioTracks[0].Language, stored.AudioTracks[1].Language})

	// The embedded track and the sidecar are both there, and the sidecar did
	// not get overwritten by the final extraction.
	languages := make([]string, 0, len(stored.SubtitleTracks))
	for _, track := range stored.SubtitleTracks {
		languages = append(languages, track.Language)
	}
	require.Contains(t, languages, "por", "the embedded subtitle is missing")
	require.Contains(t, languages, "eng", "the sidecar subtitle was lost")

	// Every published track resolves to a file the player can actually fetch.
	for position, track := range stored.SubtitleTracks {
		name := fmt.Sprintf("sub_%d_%s.vtt", position, track.Language)
		data, err := os.ReadFile(filepath.Join(server.dataDir, "rooms", roomID, "subs", name))
		require.NoError(t, err, name)
		require.Contains(t, string(data), "WEBVTT")
	}
}

// makeMultiTrackVideo builds a Matroska file with two audio tracks and one
// embedded text subtitle, which is what a release actually looks like.
func makeMultiTrackVideo(t *testing.T, seconds int) string {
	t.Helper()
	dir := t.TempDir()
	subtitle := filepath.Join(dir, "embedded.srt")
	require.NoError(t, os.WriteFile(subtitle, []byte(
		"1\n00:00:00,500 --> 00:00:02,500\nLegenda embutida\n"), 0o644))

	path := filepath.Join(dir, "source.mkv")
	run(t, "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", fmt.Sprintf("testsrc=size=640x480:rate=25:duration=%d", seconds),
		"-f", "lavfi", "-i", fmt.Sprintf("sine=frequency=440:duration=%d", seconds),
		"-f", "lavfi", "-i", fmt.Sprintf("sine=frequency=880:duration=%d", seconds),
		"-i", subtitle,
		"-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:s",
		"-c:v", "libx264", "-preset", "ultrafast", "-g", "25", "-b:v", "2M",
		"-c:a", "aac", "-c:s", "srt",
		"-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=jpn",
		"-metadata:s:s:0", "language=por",
		path)
	return path
}

// TestEmbeddedSubtitlesArriveDuringTheDownload isolates the muxed-in case,
// which is what most releases actually ship: no sibling files at all, and a
// viewer who should still be able to read the first minutes.
func TestEmbeddedSubtitlesArriveDuringTheDownload(t *testing.T) {
	requireFFmpeg(t)

	video := makeMultiTrackVideo(t, 16)
	info, err := os.Stat(video)
	require.NoError(t, err)
	content, err := os.ReadFile(video)
	require.NoError(t, err)

	// Slow enough that "during the download" is a meaningful window rather
	// than a race the test happens to win.
	bridge := newThrottledBridge(content, len(content)/30, "movie.mkv")
	bridgeServer := httptest.NewServer(bridge)
	t.Cleanup(bridgeServer.Close)

	server := startServer(t, bridgeServer.URL)
	roomID := server.createRoom(t, "movie.mkv")
	server.post(t, "/api/rooms/"+roomID+"/torrent", map[string]any{
		"sessionId": "session-1", "path": "movie.mkv",
		"fileName": "movie.mkv", "size": info.Size(),
	}, http.StatusAccepted)

	var receivedWhenPublished int64
	require.Eventually(t, func() bool {
		stored, err := server.store.Get(t.Context(), roomID)
		if err != nil || len(stored.SubtitleTracks) == 0 {
			return false
		}
		receivedWhenPublished = stored.Preparation.ReceivedBytes
		return true
	}, 60*time.Second, 200*time.Millisecond,
		"the embedded subtitle only appeared once the download had finished")

	require.Less(t, receivedWhenPublished, info.Size(),
		"the subtitle waited for the last byte, which is the delay this fixes")
	t.Logf("subtitles readable after %d of %d bytes", receivedWhenPublished, info.Size())

	// And the file the player will ask for actually holds cues.
	stored, err := server.store.Get(t.Context(), roomID)
	require.NoError(t, err)
	name := fmt.Sprintf("sub_0_%s.vtt", stored.SubtitleTracks[0].Language)
	data, err := os.ReadFile(filepath.Join(server.dataDir, "rooms", roomID, "subs", name))
	require.NoError(t, err)
	require.Contains(t, string(data), "-->")
}

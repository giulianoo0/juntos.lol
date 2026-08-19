package torrent

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// fakeUpload is a tus endpoint that only does what the ingest depends on:
// create, accept bytes at an offset, and report how far it got.
type fakeUpload struct {
	mu sync.Mutex
	// stored is what the "store" holds.
	stored []byte
	// truncateAt, when positive, makes the first PATCH stop after that many
	// bytes and drop the connection, standing in for a stream that breaks.
	truncateAt int
	patches    int
}

func (f *fakeUpload) handler(t *testing.T) http.Handler {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/upload/", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			w.Header().Set("Location", "http://"+r.Host+"/api/upload/abc")
			w.WriteHeader(http.StatusCreated)
		case http.MethodHead:
			f.mu.Lock()
			defer f.mu.Unlock()
			w.Header().Set("Upload-Offset", strconv.Itoa(len(f.stored)))
			w.WriteHeader(http.StatusOK)
		case http.MethodPatch:
			f.mu.Lock()
			patch := f.patches
			f.patches++
			limit := f.truncateAt
			f.mu.Unlock()

			reader := io.Reader(r.Body)
			if patch == 0 && limit > 0 {
				reader = io.LimitReader(r.Body, int64(limit))
			}
			data, _ := io.ReadAll(reader)

			f.mu.Lock()
			f.stored = append(f.stored, data...)
			offset := len(f.stored)
			f.mu.Unlock()

			if patch == 0 && limit > 0 {
				// A connection that dies mid-body is what the ingest has to
				// survive, so answer nothing at all.
				if hijacker, ok := w.(http.Hijacker); ok {
					conn, _, err := hijacker.Hijack()
					require.NoError(t, err)
					conn.Close()
					return
				}
			}
			w.Header().Set("Upload-Offset", strconv.Itoa(offset))
			w.WriteHeader(http.StatusNoContent)
		}
	})
	return mux
}

// fakeBridge serves the torrent side: a select, a whole-file stream from an
// offset, a file list and a close.
type fakeBridge struct {
	content   []byte
	files     []FileInfo
	sideFiles map[string][]byte
	// serveBytes, when set, caps how much of the file each stream delivers
	// before ending, standing in for a swarm that cannot supply the next piece.
	serveBytes *int

	mu       sync.Mutex
	streams  []int64
	selected string
	closed   bool
}

func (b *fakeBridge) handler() http.Handler {
	mux := http.NewServeMux()
	decode := func(r *http.Request) map[string]any {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		return body
	}
	mux.HandleFunc("/api/torrent-bridge/select", func(w http.ResponseWriter, r *http.Request) {
		body := decode(r)
		b.mu.Lock()
		b.selected, _ = body["path"].(string)
		b.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	})
	mux.HandleFunc("/api/torrent-bridge/stream", func(w http.ResponseWriter, r *http.Request) {
		body := decode(r)
		start := int64(0)
		if raw, ok := body["start"].(float64); ok {
			start = int64(raw)
		}
		b.mu.Lock()
		b.streams = append(b.streams, start)
		b.mu.Unlock()
		end := int64(len(b.content))
		if b.serveBytes != nil {
			end = min(start+int64(*b.serveBytes), end)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(b.content[start:end])
	})
	mux.HandleFunc("/api/torrent-bridge/files", func(w http.ResponseWriter, _ *http.Request) {
		files := b.files
		if files == nil {
			// The ingest checks the chosen file against this list, so a test
			// that does not care about the listing still needs the video in it.
			files = []FileInfo{
				{Name: "movie.mkv", Path: "movie.mkv", Size: int64(len(b.content))},
				{Name: "movie.mkv", Path: "movie/movie.mkv", Size: int64(len(b.content))},
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"name": "t", "files": files})
	})
	mux.HandleFunc("/api/torrent-bridge/read-file", func(w http.ResponseWriter, r *http.Request) {
		body := decode(r)
		path, _ := body["path"].(string)
		data, ok := b.sideFiles[path]
		if !ok {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		_, _ = w.Write(data)
	})
	mux.HandleFunc("/api/torrent-bridge/close", func(w http.ResponseWriter, _ *http.Request) {
		b.mu.Lock()
		b.closed = true
		b.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	})
	return mux
}

func newTestIngestor(t *testing.T, bridge *fakeBridge, upload *fakeUpload, hooks Hooks) *Ingestor {
	t.Helper()
	bridgeServer := httptest.NewServer(bridge.handler())
	t.Cleanup(bridgeServer.Close)
	uploadServer := httptest.NewServer(upload.handler(t))
	t.Cleanup(uploadServer.Close)

	ingestor := NewIngestor(NewBridge(bridgeServer.URL), uploadServer.URL+"/api/upload/", 2,
		func(string) bool { return false }, hooks)
	ingestor.backoff = time.Millisecond
	return ingestor
}

func TestIngestMovesTheWholeFile(t *testing.T) {
	content := bytes.Repeat([]byte("abcdefgh"), 4096)
	bridge := &fakeBridge{content: content}
	upload := &fakeUpload{}
	ingestor := newTestIngestor(t, bridge, upload, Hooks{})

	require.NoError(t, ingestor.run(t.Context(), Job{
		RoomID: "r1", SessionID: "s1", Path: "movie/movie.mkv",
		FileName: "movie.mkv", Size: int64(len(content)),
	}))

	require.Equal(t, content, upload.stored)
	require.Equal(t, "movie/movie.mkv", bridge.selected)
	// One stream, from the beginning: no byte was fetched twice.
	require.Equal(t, []int64{0}, bridge.streams)
	require.True(t, bridge.closed)
}

func TestIngestResumesFromWhatTheStoreKept(t *testing.T) {
	content := bytes.Repeat([]byte("0123456789"), 4096)
	bridge := &fakeBridge{content: content}
	// The first transfer dies a third of the way in.
	upload := &fakeUpload{truncateAt: len(content) / 3}
	ingestor := newTestIngestor(t, bridge, upload, Hooks{})

	require.NoError(t, ingestor.run(t.Context(), Job{
		RoomID: "r1", SessionID: "s1", Path: "movie.mkv",
		FileName: "movie.mkv", Size: int64(len(content)),
	}))

	require.Equal(t, content, upload.stored)
	// The second stream starts exactly where the store stopped, so the swarm
	// is never asked for bytes that were already accepted.
	require.Len(t, bridge.streams, 2)
	require.Equal(t, int64(0), bridge.streams[0])
	require.Equal(t, int64(len(content)/3), bridge.streams[1])
}

func TestIngestGivesUpWhenNoByteEverLands(t *testing.T) {
	// A swarm that hands over nothing, every time. Retrying that forever
	// leaves the room preparing until its TTL runs out, so it has to end.
	none := 0
	bridge := &fakeBridge{content: bytes.Repeat([]byte("x"), 1024), serveBytes: &none}
	ingestor := newTestIngestor(t, bridge, &fakeUpload{}, Hooks{})

	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	err := ingestor.run(ctx, Job{
		RoomID: "r1", SessionID: "s1", Path: "movie.mkv",
		FileName: "movie.mkv", Size: 1024,
	})
	require.ErrorContains(t, err, "stalled at 0/1024 bytes")
	require.Len(t, bridge.streams, resumeAttempts)
}

func TestIngestKeepsGoingWhileTheSwarmStillDelivers(t *testing.T) {
	// Each stream ends early but hands over something, which is a slow swarm
	// rather than a broken one: it must not count against the retry budget.
	chunk := 100
	bridge := &fakeBridge{content: bytes.Repeat([]byte("y"), 1000), serveBytes: &chunk}
	upload := &fakeUpload{}
	ingestor := newTestIngestor(t, bridge, upload, Hooks{})

	require.NoError(t, ingestor.run(t.Context(), Job{
		RoomID: "r1", SessionID: "s1", Path: "movie.mkv",
		FileName: "movie.mkv", Size: 1000,
	}))
	require.Len(t, upload.stored, 1000)
	// Ten partial streams, each resuming exactly where the last one stopped.
	require.Len(t, bridge.streams, 10)
	require.Equal(t, int64(900), bridge.streams[9])
}

func TestIngestPublishesSiblingSubtitles(t *testing.T) {
	content := bytes.Repeat([]byte("v"), 2048)
	bridge := &fakeBridge{
		content: content,
		files: []FileInfo{
			{Name: "movie.mkv", Path: "movie.mkv", Size: 2048},
			{Name: "movie.en.srt", Path: "subs/movie.en.srt", Size: 12},
			{Name: "poster.jpg", Path: "poster.jpg", Size: 40},
		},
		sideFiles: map[string][]byte{"subs/movie.en.srt": []byte("hello world!")},
	}
	upload := &fakeUpload{}

	published := make(chan []SideFile, 1)
	bridgeServer := httptest.NewServer(bridge.handler())
	t.Cleanup(bridgeServer.Close)
	uploadServer := httptest.NewServer(upload.handler(t))
	t.Cleanup(uploadServer.Close)
	ingestor := NewIngestor(NewBridge(bridgeServer.URL), uploadServer.URL+"/api/upload/", 2,
		func(name string) bool { return bytes.HasSuffix([]byte(name), []byte(".srt")) },
		Hooks{OnSubtitles: func(_ string, files []SideFile) { published <- files }})

	require.NoError(t, ingestor.run(t.Context(), Job{
		RoomID: "r1", SessionID: "s1", Path: "movie.mkv",
		FileName: "movie.mkv", Size: int64(len(content)),
	}))

	select {
	case files := <-published:
		require.Len(t, files, 1)
		require.Equal(t, "movie.en.srt", files[0].Name)
		require.Equal(t, []byte("hello world!"), files[0].Data)
	case <-time.After(2 * time.Second):
		t.Fatal("sibling subtitles were never published")
	}
}

func TestIngestOneJobPerRoom(t *testing.T) {
	bridge := &fakeBridge{content: bytes.Repeat([]byte("x"), 64)}
	ingestor := newTestIngestor(t, bridge, &fakeUpload{}, Hooks{})
	ingestor.Start(t.Context())

	job := Job{RoomID: "r1", SessionID: "s1", Path: "a.mkv", FileName: "a.mkv", Size: 64}
	require.NoError(t, ingestor.Submit(job))
	// A second submission for the same room replaces the first rather than
	// running two transfers into one upload.
	require.NoError(t, ingestor.Submit(job))

	require.Eventually(t, func() bool {
		ingestor.mu.Lock()
		defer ingestor.mu.Unlock()
		return len(ingestor.running) <= 1
	}, 2*time.Second, 20*time.Millisecond)
}

func TestIngestRefusesMoreRoomsThanItCanRun(t *testing.T) {
	bridge := &fakeBridge{content: bytes.Repeat([]byte("x"), 1<<20)}
	upload := &fakeUpload{}
	bridgeServer := httptest.NewServer(bridge.handler())
	t.Cleanup(bridgeServer.Close)
	uploadServer := httptest.NewServer(upload.handler(t))
	t.Cleanup(uploadServer.Close)
	ingestor := NewIngestor(NewBridge(bridgeServer.URL), uploadServer.URL+"/api/upload/", 1, nil, Hooks{})
	ingestor.Start(t.Context())

	require.NoError(t, ingestor.Submit(Job{RoomID: "r1", SessionID: "s1", Path: "a", FileName: "a.mkv", Size: 1 << 20}))
	err := ingestor.Submit(Job{RoomID: "r2", SessionID: "s2", Path: "b", FileName: "b.mkv", Size: 1 << 20})
	require.ErrorIs(t, err, ErrBusy)
}

func TestBridgeIsDisabledWithoutAURL(t *testing.T) {
	require.Nil(t, NewBridge(""))
	require.False(t, NewIngestor(nil, "", 1, nil, Hooks{}).Enabled())
}

func TestEncodeMetadataIsStableAndBase64(t *testing.T) {
	header := encodeMetadata(map[string]string{"roomID": "r1", "filename": "a b.mkv"})
	require.Equal(t, "filename YSBiLm1rdg==,roomID cjE=", header)
}

func TestResolveLocationHandlesRelativeAnswers(t *testing.T) {
	require.Equal(t, "http://h/api/upload/x",
		resolveLocation("http://h/api/upload/", "x"))
	require.Equal(t, "http://h/api/upload/x",
		resolveLocation("http://h/api/upload/", "http://h/api/upload/x"))
}

func TestIngestRefusesASizeTheTorrentDoesNotHave(t *testing.T) {
	// The size comes from a browser and the tus upload is created against it,
	// so a wrong one would produce an upload that can never complete.
	bridge := &fakeBridge{content: bytes.Repeat([]byte("x"), 512)}
	ingestor := newTestIngestor(t, bridge, &fakeUpload{}, Hooks{})

	err := ingestor.run(t.Context(), Job{
		RoomID: "r1", SessionID: "s1", Path: "movie.mkv",
		FileName: "movie.mkv", Size: 999999,
	})
	require.ErrorContains(t, err, "is 512 bytes, not 999999")
	require.Empty(t, bridge.streams)
}

func TestIngestRefusesAFileTheTorrentDoesNotHave(t *testing.T) {
	bridge := &fakeBridge{content: bytes.Repeat([]byte("x"), 512)}
	ingestor := newTestIngestor(t, bridge, &fakeUpload{}, Hooks{})

	err := ingestor.run(t.Context(), Job{
		RoomID: "r1", SessionID: "s1", Path: "elsewhere.mkv",
		FileName: "elsewhere.mkv", Size: 512,
	})
	require.ErrorContains(t, err, `no file "elsewhere.mkv"`)
}

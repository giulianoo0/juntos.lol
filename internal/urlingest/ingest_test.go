package urlingest

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// An origin that behaves like a CDN serving a video: it honours Range and it
// says how big the file is. `serves` is what it actually hands over, which is
// how a stale library announcing the wrong size gets simulated.
func fakeOrigin(t *testing.T, size int, serves string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/x-matroska")
		rang := r.Header.Get("Range")
		if rang == "" {
			w.Header().Set("Content-Length", strconv.Itoa(len(serves)))
			_, _ = io.WriteString(w, serves)
			return
		}
		from := 0
		if _, err := fmt.Sscanf(rang, "bytes=%d-", &from); err != nil {
			from = 0
		}
		if rang == "bytes=0-0" {
			w.Header().Set("Content-Range", fmt.Sprintf("bytes 0-0/%d", size))
			w.Header().Set("Content-Length", "1")
			w.WriteHeader(http.StatusPartialContent)
			_, _ = io.WriteString(w, serves[:1])
			return
		}
		body := serves[min(from, len(serves)):]
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", from, size-1, size))
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = io.WriteString(w, body)
	}))
}

// A tus endpoint just complete enough to be pumped into.
func fakeTus(t *testing.T, received *strings.Builder, mu *sync.Mutex) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			w.Header().Set("Location", "/uploads/1")
			w.WriteHeader(http.StatusCreated)
		case http.MethodHead:
			mu.Lock()
			defer mu.Unlock()
			w.Header().Set("Upload-Offset", strconv.Itoa(received.Len()))
			w.WriteHeader(http.StatusOK)
		case http.MethodPatch:
			body, _ := io.ReadAll(r.Body)
			mu.Lock()
			received.Write(body)
			w.Header().Set("Upload-Offset", strconv.Itoa(received.Len()))
			mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		}
	}))
}

// The guard refuses httptest's loopback address, so these tests inject a
// client without it. The guard has its own tests; these are about the pump.
func testIngestor(t *testing.T, tusURL string, done chan error) *Ingestor {
	t.Helper()
	ingestor := NewIngestor(tusURL+"/uploads", 1, 1<<30, Hooks{
		OnFailed: func(_ string, err error) { done <- err },
		OnDone:   func(string) { done <- nil },
	})
	ingestor.client = &http.Client{Timeout: 10 * time.Second}
	ingestor.check = func(raw string) (*url.URL, error) { return url.Parse(raw) }
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	ingestor.Start(ctx)
	return ingestor
}

func waitFor(t *testing.T, done chan error) error {
	t.Helper()
	select {
	case err := <-done:
		return err
	case <-time.After(10 * time.Second):
		t.Fatal("ingest did not finish")
		return nil
	}
}

func TestIngestPumpsTheWholeBody(t *testing.T) {
	payload := strings.Repeat("video-bytes", 512)
	source := fakeOrigin(t, len(payload), payload)
	defer source.Close()

	var received strings.Builder
	var mu sync.Mutex
	tus := fakeTus(t, &received, &mu)
	defer tus.Close()

	done := make(chan error, 1)
	ingestor := testIngestor(t, tus.URL, done)
	if err := ingestor.Submit(Job{RoomID: "r1", URL: source.URL + "/movie.mkv", FileName: "movie.mkv", Size: int64(len(payload))}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	if err := waitFor(t, done); err != nil {
		t.Fatalf("ingest failed: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if received.String() != payload {
		t.Fatalf("received %d bytes, want %d", received.Len(), len(payload))
	}
}

// The common case: a stream carries a url and no byte count.
func TestIngestAsksTheOriginWhenTheSizeIsUnknown(t *testing.T) {
	payload := strings.Repeat("video-bytes", 512)
	source := fakeOrigin(t, len(payload), payload)
	defer source.Close()

	var received strings.Builder
	var mu sync.Mutex
	tus := fakeTus(t, &received, &mu)
	defer tus.Close()

	done := make(chan error, 1)
	ingestor := testIngestor(t, tus.URL, done)
	if err := ingestor.Submit(Job{RoomID: "r2", URL: source.URL + "/movie.mkv", FileName: "movie.mkv"}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	if err := waitFor(t, done); err != nil {
		t.Fatalf("ingest failed: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if received.Len() != len(payload) {
		t.Fatalf("received %d bytes, want %d", received.Len(), len(payload))
	}
}

func TestIngestRefusesAnHTMLErrorPage(t *testing.T) {
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, "<html>not here</html>")
	}))
	defer source.Close()

	var received strings.Builder
	var mu sync.Mutex
	tus := fakeTus(t, &received, &mu)
	defer tus.Close()

	done := make(chan error, 1)
	ingestor := testIngestor(t, tus.URL, done)
	if err := ingestor.Submit(Job{RoomID: "r3", URL: source.URL + "/movie.mkv", FileName: "m.mkv", Size: 21}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	if err := waitFor(t, done); !errors.Is(err, ErrNotVideo) {
		t.Fatalf("err = %v, want ErrNotVideo", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if received.Len() != 0 {
		t.Fatalf("wrote %d bytes of an html page into the room", received.Len())
	}
}

// The failure this catches is the quiet one: an announced size smaller than
// the file. Trusting it would cut the film at the announced length, complete
// the PATCH, and report success.
func TestIngestRefusesASourceLongerThanAnnounced(t *testing.T) {
	payload := strings.Repeat("video-bytes", 512)
	source := fakeOrigin(t, len(payload), payload)
	defer source.Close()

	var received strings.Builder
	var mu sync.Mutex
	tus := fakeTus(t, &received, &mu)
	defer tus.Close()

	done := make(chan error, 1)
	ingestor := testIngestor(t, tus.URL, done)
	// Half the real size.
	if err := ingestor.Submit(Job{RoomID: "r4", URL: source.URL + "/m.mkv", FileName: "m.mkv", Size: int64(len(payload) / 2)}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	if err := waitFor(t, done); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err = %v, want ErrTooLarge — a short file was accepted as complete", err)
	}
}

func TestIngestRefusesToWriteTheStartOfAFileIntoTheMiddle(t *testing.T) {
	payload := strings.Repeat("video-bytes", 512)
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/x-matroska")
		rang := r.Header.Get("Range")
		if rang == "bytes=0-0" {
			w.Header().Set("Content-Range", "bytes 0-0/"+strconv.Itoa(len(payload)))
			w.Header().Set("Content-Length", "1")
			w.WriteHeader(http.StatusPartialContent)
			_, _ = io.WriteString(w, payload[:1])
			return
		}
		// A resumed request is answered 200 with the file from the start —
		// the origin ignoring Range, which is the case this exists for.
		w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
		if rang == "" {
			// First pass hands over only half, forcing a resume.
			_, _ = io.WriteString(w, payload[:len(payload)/2])
			return
		}
		_, _ = io.WriteString(w, payload)
	}))
	defer source.Close()

	var received strings.Builder
	var mu sync.Mutex
	tus := fakeTus(t, &received, &mu)
	defer tus.Close()

	done := make(chan error, 1)
	ingestor := testIngestor(t, tus.URL, done)
	ingestor.backoff = time.Millisecond
	if err := ingestor.Submit(Job{RoomID: "r5", URL: source.URL + "/m.mkv", FileName: "m.mkv", Size: int64(len(payload))}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	if err := waitFor(t, done); !errors.Is(err, ErrNoRange) {
		t.Fatalf("err = %v, want ErrNoRange", err)
	}
}

func TestIngestRefusesAPrivateURL(t *testing.T) {
	ingestor := NewIngestor("http://example.invalid/uploads", 1, 1<<30, Hooks{})
	// https, so the scheme check is not what refuses it: CheckURL tests scheme
	// before address, and http here would pass for the wrong reason.
	err := ingestor.Submit(Job{RoomID: "r1", URL: "https://127.0.0.1/movie.mkv", FileName: "m.mkv", Size: 10})
	if !errors.Is(err, ErrPrivateAddress) {
		t.Fatalf("err = %v, want ErrPrivateAddress", err)
	}
}

func TestRedactStripsATokenOutOfAnError(t *testing.T) {
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	source.Close() // closed on purpose: the request fails with a *url.Error


	ingestor := NewIngestor("http://example.invalid/uploads", 1, 1<<30, Hooks{})
	ingestor.client = &http.Client{Timeout: time.Second}
	_, err := ingestor.probeSize(context.Background(), Job{URL: source.URL + "/f.mkv?X-Plex-Token=secret"})
	if err == nil {
		t.Fatal("expected the probe to fail")
	}
	if strings.Contains(redact(err).Error(), "secret") {
		t.Fatalf("the token survived redaction: %v", redact(err))
	}
}

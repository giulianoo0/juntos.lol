package objectstore

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// FakeObject is one stored object as the fake recorded it.
type FakeObject struct {
	Body         []byte
	ContentType  string
	CacheControl string
}

// Fake is an in-memory Store for tests. It is in the non-test build so that
// every package exercising the media pipeline can reach it.
type Fake struct {
	mu      sync.Mutex
	objects map[string]FakeObject
	puts    map[string]int
	// FailOn makes Put fail for keys it reports true for, which is how the
	// no-fallback contract gets tested: a failed upload must fail the job.
	FailOn func(key string) bool
}

func NewFake() *Fake {
	return &Fake{objects: make(map[string]FakeObject), puts: make(map[string]int)}
}

// Stat mirrors R2.Stat: the size of a stored object, or an error for a key
// nothing ever wrote.
func (f *Fake) Stat(_ context.Context, key string) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	object, ok := f.objects[key]
	if !ok {
		return 0, fmt.Errorf("objectstore: fake stat %s: not found", key)
	}
	return int64(len(object.Body)), nil
}

// PresignPut mirrors R2.PresignPut with an inert URL: httpapi tests exercise
// the shape of the response, never the bucket's signature math.
func (f *Fake) PresignPut(_ context.Context, key, contentType, cacheControl string,
	_ time.Duration) (string, http.Header, error) {
	return "https://fake.bucket.invalid/" + key, http.Header{
		"Content-Type":  []string{contentType},
		"Cache-Control": []string{cacheControl},
	}, nil
}

func (f *Fake) Put(_ context.Context, key string, reader io.Reader, _ int64,
	contentType, cacheControl string) error {
	f.mu.Lock()
	failOn := f.FailOn
	f.mu.Unlock()
	if failOn != nil && failOn(key) {
		return fmt.Errorf("objectstore: fake refused %s", key)
	}
	body, err := io.ReadAll(reader)
	if err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.objects[key] = FakeObject{Body: body, ContentType: contentType, CacheControl: cacheControl}
	f.puts[key]++
	return nil
}

func (f *Fake) RemovePrefix(_ context.Context, prefix string) error {
	if prefix == "" {
		return ErrEmptyPrefix
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.FailOn != nil && f.FailOn(prefix) {
		return fmt.Errorf("objectstore: fake refused to remove %s", prefix)
	}
	for key := range f.objects {
		if strings.HasPrefix(key, prefix) {
			delete(f.objects, key)
		}
	}
	return nil
}

// Puts reports how many times a key was written. Every write is one billed
// operation against the real bucket, so a test can hold the pipeline to
// uploading only what changed.
func (f *Fake) Puts(key string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.puts[key]
}

// SetFailOn changes the refusal predicate. It exists so a test can flip the
// bucket's behaviour while a publisher goroutine is reading it.
func (f *Fake) SetFailOn(failOn func(key string) bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.FailOn = failOn
}

// Get returns a stored object and whether it exists.
func (f *Fake) Get(key string) (FakeObject, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	object, ok := f.objects[key]
	return object, ok
}

// Keys returns every stored key, unordered.
func (f *Fake) Keys() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	keys := make([]string, 0, len(f.objects))
	for key := range f.objects {
		keys = append(keys, key)
	}
	return keys
}

package objectstore

import (
	"context"
	"fmt"
	"io"
	"sync"
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
	// FailOn makes Put fail for keys it reports true for, which is how the
	// no-fallback contract gets tested: a failed upload must fail the job.
	FailOn func(key string) bool
}

func NewFake() *Fake {
	return &Fake{objects: make(map[string]FakeObject)}
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
	return nil
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

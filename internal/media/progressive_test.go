package media

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestProbeGrowingFileRetriesTransientPartialReads(t *testing.T) {
	attempts := 0
	want := &ProbeResult{VideoCodec: "h264", VideoCopyable: true}

	got, err := probeGrowingFile(t.Context(), "/tmp/growing.mkv", time.Millisecond,
		func(context.Context, string) (*ProbeResult, error) {
			attempts++
			if attempts < 3 {
				return nil, errors.New("file ended prematurely")
			}
			return want, nil
		})

	require.NoError(t, err)
	require.Same(t, want, got)
	require.Equal(t, 3, attempts)
}

func TestProbeGrowingFileStopsOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()

	_, err := probeGrowingFile(ctx, "/tmp/growing.mkv", time.Millisecond,
		func(context.Context, string) (*ProbeResult, error) {
			return nil, errors.New("file ended prematurely")
		})

	require.ErrorIs(t, err, context.Canceled)
}

func TestStreamGrowingFileFollowsAppendsUntilCancellation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "growing.mkv")
	require.NoError(t, os.WriteFile(path, []byte("first"), 0o644))

	ctx, cancel := context.WithCancel(t.Context())
	var output lockedBuffer
	done := make(chan error, 1)
	go func() {
		done <- streamGrowingFile(ctx, path, &output, time.Millisecond)
	}()

	require.Eventually(t, func() bool { return output.String() == "first" }, time.Second, time.Millisecond)
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	require.NoError(t, err)
	_, err = file.WriteString("-second")
	require.NoError(t, err)
	require.NoError(t, file.Close())
	require.Eventually(t, func() bool { return output.String() == "first-second" }, time.Second, time.Millisecond)

	cancel()
	require.ErrorIs(t, <-done, context.Canceled)
}

func TestProgressiveOutputReadyRequiresPlayableSegment(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "master.m3u8"), []byte("master"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "preview_stream_0.m3u8"), []byte("media"), 0o644))
	require.False(t, progressiveOutputReady(dir))

	require.NoError(t, os.WriteFile(filepath.Join(dir, "preview_stream_0_000000.m4s"), []byte("segment"), 0o644))
	require.False(t, progressiveOutputReady(dir))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "preview_init_0.mp4"), []byte("init"), 0o644))
	require.True(t, progressiveOutputReady(dir))
}

func TestProgressiveCancelKeepsQueuedJobCanceled(t *testing.T) {
	p := NewProgressive(1, nil, t.TempDir(), nil)
	p.ctx = t.Context()
	p.started = true

	p.Submit("r1", "/tmp/growing.mkv")
	p.Cancel("r1")
	p.Submit("r1", "/tmp/growing.mkv")

	require.Len(t, p.jobs, 1)
	_, ok := p.beginJob(t.Context(), "r1")
	require.False(t, ok)
}

type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (b *lockedBuffer) Write(data []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.Write(data)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.String()
}

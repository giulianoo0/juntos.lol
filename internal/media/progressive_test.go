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

	"github.com/giulianoo0/ss/internal/room"
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

func TestVideoVariantPlaylistFollowsAudioCount(t *testing.T) {
	require.Equal(t, "preview_stream_0.m3u8",
		videoVariantPlaylist("preview_stream", &ProbeResult{}))
	require.Equal(t, "preview_stream_2.m3u8",
		videoVariantPlaylist("preview_stream", &ProbeResult{Audio: []room.TrackInfo{{Index: 0}, {Index: 1}}}))
}

func TestProgressiveCancelKeepsQueuedJobCanceled(t *testing.T) {
	p := NewProgressive(1, nil, t.TempDir(), nil, 1<<20, nil, nil)
	p.ctx = t.Context()
	p.started = true

	p.Submit("r1", "/tmp/growing.mkv", 0)
	p.Cancel("r1")
	p.Submit("r1", "/tmp/growing.mkv", 0)

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

func TestProbeGrowingFileGivesUpOnASourceThatCannotStream(t *testing.T) {
	// An MP4 whose media precedes its index: ffprobe will fail on every prefix
	// of it, so retrying until the upload completes burns an ffprobe twice a
	// second for the whole download and tells the room nothing.
	data := append(box("ftyp", 24), make([]byte, 16)...)
	data = append(data, box("mdat", 900_000_000)...)
	path := filepath.Join(t.TempDir(), "trailing-moov.mp4")
	require.NoError(t, os.WriteFile(path, data, 0o644))

	attempts := 0
	_, err := probeGrowingFile(t.Context(), path, time.Millisecond,
		func(context.Context, string) (*ProbeResult, error) {
			attempts++
			return nil, errors.New("moov atom not found")
		})

	require.ErrorIs(t, err, ErrContainerUnknown)
	require.Equal(t, 1, attempts)
}

func TestProbeGrowingFileKeepsWaitingForAStreamableSource(t *testing.T) {
	// Matroska streams, so a failing probe only means the header has not
	// finished arriving. Giving up on it would be the wrong answer.
	path := filepath.Join(t.TempDir(), "growing.mkv")
	require.NoError(t, os.WriteFile(path, []byte{0x1A, 0x45, 0xDF, 0xA3, 0, 0, 0, 0}, 0o644))

	want := &ProbeResult{VideoCodec: "h264", VideoCopyable: true}
	attempts := 0
	got, err := probeGrowingFile(t.Context(), path, time.Millisecond,
		func(context.Context, string) (*ProbeResult, error) {
			attempts++
			if attempts < 3 {
				return nil, errors.New("file ended prematurely")
			}
			return want, nil
		})

	require.NoError(t, err)
	require.Same(t, want, got)
}

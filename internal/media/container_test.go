package media

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// box renders one MP4 box header of the given total size.
func box(name string, size uint32) []byte {
	header := make([]byte, 8)
	binary.BigEndian.PutUint32(header[:4], size)
	copy(header[4:], name)
	return header
}

func writeFile(t *testing.T, data []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "partial")
	require.NoError(t, os.WriteFile(path, data, 0o600))
	return path
}

func TestNeedsWholeFileFaststartMP4Streams(t *testing.T) {
	// ftyp, then the index, then the media: playable from a prefix.
	data := append(box("ftyp", 24), make([]byte, 16)...)
	data = append(data, box("moov", 4096)...)
	require.Equal(t, uint32(24), binary.BigEndian.Uint32(data[:4]))

	whole, err := NeedsWholeFile(writeFile(t, data))
	require.NoError(t, err)
	require.False(t, whole)
}

func TestNeedsWholeFileTrailingMoovNeedsEverything(t *testing.T) {
	// ftyp, then the media, with the index only after it: this is the file
	// that leaves a room preparing forever.
	data := append(box("ftyp", 24), make([]byte, 16)...)
	data = append(data, box("mdat", 900_000_000)...)

	whole, err := NeedsWholeFile(writeFile(t, data))
	require.NoError(t, err)
	require.True(t, whole)
}

func TestNeedsWholeFileMatroskaIsNeverBlocked(t *testing.T) {
	// An EBML header does not look like an MP4 box at all.
	data := append([]byte{0x1A, 0x45, 0xDF, 0xA3, 0x01, 0x00, 0x00, 0x00}, make([]byte, 64)...)

	whole, err := NeedsWholeFile(writeFile(t, data))
	require.NoError(t, err)
	require.False(t, whole)
}

func TestNeedsWholeFileTooShortToTell(t *testing.T) {
	_, err := NeedsWholeFile(writeFile(t, []byte{0, 0, 0}))
	require.ErrorIs(t, err, ErrContainerUnknown)
}

func TestNeedsWholeFileMP4WithNeitherBoxYet(t *testing.T) {
	// ftyp followed by a free box large enough that neither moov nor mdat has
	// arrived: the answer is not knowable yet, and guessing either way is
	// worse than waiting.
	data := append(box("ftyp", 24), make([]byte, 16)...)
	data = append(data, box("free", 200_000)...)

	_, err := NeedsWholeFile(writeFile(t, data))
	require.ErrorIs(t, err, ErrContainerUnknown)
}

func TestNeedsWholeFileRejectsMalformedBoxSize(t *testing.T) {
	// A box claiming a size smaller than its own header cannot be walked past.
	data := append(box("ftyp", 24), make([]byte, 16)...)
	data = append(data, box("junk", 3)...)

	_, err := NeedsWholeFile(writeFile(t, data))
	require.ErrorIs(t, err, ErrContainerUnknown)
}

func TestPreviewTargetBytesScalesWithBitrate(t *testing.T) {
	// 2 GB over two hours is ~290 KB/s, so 20 seconds is a few megabytes.
	const twoGB = 2 << 30
	const twoHoursMs = 2 * 60 * 60 * 1000
	target := PreviewTargetBytes(twoGB, twoHoursMs, 1<<20)
	require.Equal(t, int64(twoGB)*PreviewSeconds*1000/twoHoursMs, target)
	require.Greater(t, target, int64(1<<20))
}

func TestPreviewTargetBytesNeverBelowTheFloor(t *testing.T) {
	// A very long, very small file would otherwise estimate a target below
	// the threshold that starts the preview in the first place.
	require.Equal(t, int64(1<<20), PreviewTargetBytes(10<<20, 10*60*60*1000, 1<<20))
}

func TestPreviewTargetBytesNeverExceedsTheSource(t *testing.T) {
	// A clip shorter than the preview window needs all of itself, no more.
	require.Equal(t, int64(4<<20), PreviewTargetBytes(4<<20, 5000, 1<<20))
}

func TestPreviewTargetBytesWithoutDurationDeclinesToGuess(t *testing.T) {
	require.Zero(t, PreviewTargetBytes(2<<30, 0, 1<<20))
	require.Zero(t, PreviewTargetBytes(0, 60_000, 1<<20))
}

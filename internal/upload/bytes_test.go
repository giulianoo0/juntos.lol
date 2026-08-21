package upload

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestReceivedBytesReportsOnlyWhatIsNew(t *testing.T) {
	received := newReceivedBytes()

	require.Equal(t, int64(100), received.advance("u1", 100))
	require.Equal(t, int64(150), received.advance("u1", 250))
	require.Equal(t, int64(50), received.settle("u1", 300))
}

func TestReceivedBytesNeverGoesBackwards(t *testing.T) {
	// A resumed upload reports an offset the store already confirmed. Feeding
	// the difference to a counter would panic, and feeding its absolute value
	// would count the same megabytes twice.
	received := newReceivedBytes()
	received.advance("u1", 500)

	require.Equal(t, int64(0), received.advance("u1", 200))
	require.Equal(t, int64(100), received.advance("u1", 600))
}

func TestReceivedBytesCountsAnUploadThatNeverTicked(t *testing.T) {
	// Anything that finishes inside one progress interval — every small file
	// — produces no progress event at all.
	received := newReceivedBytes()

	require.Equal(t, int64(4096), received.settle("u1", 4096))
}

func TestReceivedBytesIgnoresAProgressTickThatArrivesAfterTheUploadEnded(t *testing.T) {
	// tusd sends one last progress message when the request context ends, and
	// it races the completion message on a separate channel. Counting it would
	// report exactly twice the bytes of every upload that lost the race, which
	// is what a real upload of an 80 kB file did before this.
	received := newReceivedBytes()

	require.Equal(t, int64(79394), received.settle("u1", 79394))
	require.Equal(t, int64(0), received.advance("u1", 79394))
	require.Equal(t, int64(0), received.settle("u1", 79394))
}

func TestReceivedBytesForgetsAnUploadOnceTheStragglersCanNoLongerArrive(t *testing.T) {
	// The map would otherwise hold an entry per upload for the lifetime of
	// the process.
	received := newReceivedBytes()
	now := time.Now()
	received.now = func() time.Time { return now }
	received.advance("u1", 10)
	received.settle("u1", 10)
	require.Equal(t, 1, received.tracked())

	now = now.Add(2 * settleGrace)
	received.settle("u2", 5)

	// Only the upload that was just settled is still on the books; the grace
	// window on the older one has run out and nothing can still arrive for it.
	require.Equal(t, 1, received.tracked())
}

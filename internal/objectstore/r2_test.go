package objectstore

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestPutOptionsKeepASegmentOnASingleRequest(t *testing.T) {
	// Above its part size the S3 client splits an upload into
	// CreateMultipartUpload + one UploadPart per chunk + CompleteMultipartUpload,
	// and R2 bills every one of them as a Class A operation. Its default part
	// size is 16 MiB, which a segment of a high-bitrate passthrough remux
	// clears — so the default turns one billed write into four, and pays four
	// round trips for them.
	//
	// The bound below is a six-second segment of a 60 Mbit/s remux, comfortably
	// past anything a UHD Blu-ray source produces.
	const largestSegmentBytes = 6 * 60 * 1000 * 1000 / 8

	options := putOptions("video/iso.segment", "public, max-age=31536000, immutable")

	require.GreaterOrEqual(t, options.PartSize, uint64(largestSegmentBytes))
	require.Equal(t, "video/iso.segment", options.ContentType)
	require.Equal(t, "public, max-age=31536000, immutable", options.CacheControl)
}

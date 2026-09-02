package objectstore

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestPutOptionsKeepASegmentOnASingleRequest(t *testing.T) {
	const largestSegmentBytes = 6 * 60 * 1000 * 1000 / 8

	options := putOptions("video/iso.segment", "public, max-age=31536000, immutable")

	require.GreaterOrEqual(t, options.PartSize, uint64(largestSegmentBytes))
	require.Equal(t, "video/iso.segment", options.ContentType)
	require.Equal(t, "public, max-age=31536000, immutable", options.CacheControl)
}

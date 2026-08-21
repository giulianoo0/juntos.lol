package objectstore

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/metrics"
)

// The classes below are Cloudflare's, not ours. They come from the R2 pricing
// page, which prices Class A at more than ten times Class B and bills nothing
// for deletes, and getting one of them wrong turns the cost dashboard into a
// confident lie.
func TestClassifyNamesTheOperationAndWhatR2BillsForIt(t *testing.T) {
	const bucket = "media"
	tests := []struct {
		name          string
		method        string
		url           string
		header        http.Header
		wantOperation string
		wantClass     string
	}{
		{
			name:   "a segment upload is one Class A write",
			method: http.MethodPut, url: "https://acct.r2.cloudflarestorage.com/media/rooms/r1/g0/hls/s.m4s",
			wantOperation: "PutObject", wantClass: metrics.ClassA,
		},
		{
			// The single-part threshold exists to keep this from happening to
			// a segment; when it does happen, every part is billed.
			name:   "every part of a multipart upload is its own Class A write",
			method: http.MethodPut, url: "https://acct.r2.cloudflarestorage.com/media/big.m4s?uploadId=u1&partNumber=3",
			wantOperation: "UploadPart", wantClass: metrics.ClassA,
		},
		{
			name:   "opening a multipart upload is a Class A write",
			method: http.MethodPost, url: "https://acct.r2.cloudflarestorage.com/media/big.m4s?uploads=",
			wantOperation: "CreateMultipartUpload", wantClass: metrics.ClassA,
		},
		{
			name:   "closing one is another",
			method: http.MethodPost, url: "https://acct.r2.cloudflarestorage.com/media/big.m4s?uploadId=u1",
			wantOperation: "CompleteMultipartUpload", wantClass: metrics.ClassA,
		},
		{
			// Listed under free operations, explicitly not Class A: giving up
			// on an upload costs nothing.
			name:   "abandoning one costs nothing",
			method: http.MethodDelete, url: "https://acct.r2.cloudflarestorage.com/media/big.m4s?uploadId=u1",
			wantOperation: "AbortMultipartUpload", wantClass: metrics.ClassFree,
		},
		{
			// This is what reclaiming a room pays: one Class A per page of a
			// thousand keys.
			name:   "each page of a listing is a Class A operation",
			method: http.MethodGet, url: "https://acct.r2.cloudflarestorage.com/media?list-type=2&prefix=rooms%2Fr1%2F",
			wantOperation: "ListObjects", wantClass: metrics.ClassA,
		},
		{
			name:   "the older listing shape is the same operation",
			method: http.MethodGet, url: "https://acct.r2.cloudflarestorage.com/media?prefix=rooms%2Fr1%2F&marker=x",
			wantOperation: "ListObjects", wantClass: metrics.ClassA,
		},
		{
			name:   "deleting the listed keys is free",
			method: http.MethodPost, url: "https://acct.r2.cloudflarestorage.com/media?delete=",
			wantOperation: "DeleteObjects", wantClass: metrics.ClassFree,
		},
		{
			name:   "deleting one key is free",
			method: http.MethodDelete, url: "https://acct.r2.cloudflarestorage.com/media/rooms/r1/g0/hls/s.m4s",
			wantOperation: "DeleteObject", wantClass: metrics.ClassFree,
		},
		{
			name:   "reading an object is the cheap class",
			method: http.MethodGet, url: "https://acct.r2.cloudflarestorage.com/media/rooms/r1/g0/hls/s.m4s",
			wantOperation: "GetObject", wantClass: metrics.ClassB,
		},
		{
			name:   "asking about an object is the cheap class",
			method: http.MethodHead, url: "https://acct.r2.cloudflarestorage.com/media/rooms/r1/g0/hls/s.m4s",
			wantOperation: "HeadObject", wantClass: metrics.ClassB,
		},
		{
			name:   "asking about the bucket is the cheap class",
			method: http.MethodHead, url: "https://acct.r2.cloudflarestorage.com/media",
			wantOperation: "HeadBucket", wantClass: metrics.ClassB,
		},
		{
			name:   "a server-side copy is a write",
			method: http.MethodPut, url: "https://acct.r2.cloudflarestorage.com/media/copy.m4s",
			header:        http.Header{"X-Amz-Copy-Source": {"/media/rooms/r1/g0/hls/s.m4s"}},
			wantOperation: "CopyObject", wantClass: metrics.ClassA,
		},
		{
			// A virtual-hosted bucket puts the whole path in the key, so the
			// same request must not read as a bucket-level listing.
			name:   "a virtual-hosted bucket still resolves to an object",
			method: http.MethodGet, url: "https://media.acct.r2.cloudflarestorage.com/rooms/r1/g0/hls/s.m4s",
			wantOperation: "GetObject", wantClass: metrics.ClassB,
		},
		{
			// Implemented by R2 and named in none of the three pricing lists.
			// Reported as unknown rather than folded into a billed class:
			// only a visible gap gets checked.
			name:   "an operation the pricing page does not name is not guessed at",
			method: http.MethodDelete, url: "https://acct.r2.cloudflarestorage.com/media?cors=",
			wantOperation: "DeleteBucketCors", wantClass: metrics.ClassUnknown,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			request := httptest.NewRequest(tt.method, tt.url, nil)
			request.URL.Host = request.Host
			if tt.header != nil {
				request.Header = tt.header
			}

			operation, class := classify(request, bucket)

			require.Equal(t, tt.wantOperation, operation)
			require.Equal(t, tt.wantClass, class)
		})
	}
}

// roundTripperFunc is a transport that answers without a network.
type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func answer(status int) *http.Response {
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader("")),
		Header:     make(http.Header),
	}
}

func TestMeteredTransportCountsOneWriteAndItsBytes(t *testing.T) {
	transport := meteredTransport{
		next:   roundTripperFunc(func(*http.Request) (*http.Response, error) { return answer(http.StatusOK), nil }),
		bucket: "media",
	}
	operations := metrics.ObjectStoreOperations.WithLabelValues("PutObject", metrics.ClassA)
	before := testutil.ToFloat64(operations)
	beforeBytes := testutil.ToFloat64(metrics.ObjectStoreBytesWritten)

	request := httptest.NewRequest(http.MethodPut,
		"https://acct.r2.cloudflarestorage.com/media/rooms/r1/g0/hls/s.m4s", strings.NewReader("0123456789"))
	request.URL.Host = request.Host
	response, err := transport.RoundTrip(request)
	require.NoError(t, err)
	require.NoError(t, response.Body.Close())

	require.Equal(t, before+1, testutil.ToFloat64(operations))
	require.Equal(t, beforeBytes+10, testutil.ToFloat64(metrics.ObjectStoreBytesWritten))
}

func TestMeteredTransportSeparatesARefusalFromAnUnreachableBucket(t *testing.T) {
	// The two failures are not the same incident: one says the bucket
	// answered and said no, the other says nothing answered at all, and only
	// the second is worth waking anyone over.
	refused := meteredTransport{
		next:   roundTripperFunc(func(*http.Request) (*http.Response, error) { return answer(http.StatusForbidden), nil }),
		bucket: "media",
	}
	unreachable := meteredTransport{
		next:   roundTripperFunc(func(*http.Request) (*http.Response, error) { return nil, io.ErrUnexpectedEOF }),
		bucket: "media",
	}
	statusErrors := metrics.ObjectStoreErrors.WithLabelValues("PutObject", metrics.ErrorStatus)
	transportErrors := metrics.ObjectStoreErrors.WithLabelValues("PutObject", metrics.ErrorTransport)
	beforeStatus := testutil.ToFloat64(statusErrors)
	beforeTransport := testutil.ToFloat64(transportErrors)
	beforeBytes := testutil.ToFloat64(metrics.ObjectStoreBytesWritten)

	for _, transport := range []meteredTransport{refused, unreachable} {
		request := httptest.NewRequest(http.MethodPut,
			"https://acct.r2.cloudflarestorage.com/media/rooms/r1/g0/hls/s.m4s", strings.NewReader("0123456789"))
		request.URL.Host = request.Host
		response, err := transport.RoundTrip(request)
		if err == nil {
			require.NoError(t, response.Body.Close())
		}
	}

	require.Equal(t, beforeStatus+1, testutil.ToFloat64(statusErrors))
	require.Equal(t, beforeTransport+1, testutil.ToFloat64(transportErrors))
	// Bytes that were refused are not bytes the bucket is storing.
	require.Equal(t, beforeBytes, testutil.ToFloat64(metrics.ObjectStoreBytesWritten))
}

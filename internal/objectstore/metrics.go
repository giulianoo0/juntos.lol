package objectstore

import (
	"net/http"
	"strings"
	"time"

	"github.com/giulianoo0/ss/internal/metrics"
)

// meteredTransport counts every request the S3 client sends to the bucket.
//
// The measurement sits in the transport rather than around Put and
// RemovePrefix because those two methods are not what R2 bills. One Put is
// one PutObject only while the object stays under the single-part threshold;
// past it the same call becomes a CreateMultipartUpload, one UploadPart per
// chunk and a CompleteMultipartUpload, each of them separately billed. One
// RemovePrefix is one ListObjects per page of a thousand keys plus a batch
// delete that costs nothing. Counting requests as they leave is the only
// place where those are individually visible, and it covers every call site
// by construction: nothing reaches the bucket without passing through here.
type meteredTransport struct {
	next   http.RoundTripper
	bucket string
}

func (t meteredTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	operation, class := classify(request, t.bucket)
	started := time.Now()
	response, err := t.next.RoundTrip(request)
	metrics.ObjectStoreDuration.WithLabelValues(operation).Observe(time.Since(started).Seconds())
	// Counted whatever the answer was, because the request was made and, with
	// the one exception of a rejected signature, R2 bills requests rather than
	// successes.
	metrics.ObjectStoreOperations.WithLabelValues(operation, class).Inc()
	switch {
	case err != nil:
		metrics.ObjectStoreErrors.WithLabelValues(operation, metrics.ErrorTransport).Inc()
	case response.StatusCode >= http.StatusBadRequest:
		metrics.ObjectStoreErrors.WithLabelValues(operation, metrics.ErrorStatus).Inc()
	case request.ContentLength > 0 && carriesObjectBody(operation):
		metrics.ObjectStoreBytesWritten.Add(float64(request.ContentLength))
	}
	return response, err
}

// carriesObjectBody names the operations whose request body is object data,
// so the byte counter measures stored bytes and not the XML of a completed
// multipart or a batch delete.
func carriesObjectBody(operation string) bool {
	return operation == opPutObject || operation == opUploadPart
}

// The S3 operation names R2 is billed by. They are spelled exactly as
// Cloudflare's pricing page spells them, so a panel legend can be read
// against the invoice without a translation step.
const (
	opPutObject                       = "PutObject"
	opCopyObject                      = "CopyObject"
	opCreateBucket                    = "CreateBucket"
	opCreateMultipartUpload           = "CreateMultipartUpload"
	opUploadPart                      = "UploadPart"
	opUploadPartCopy                  = "UploadPartCopy"
	opCompleteMultipartUpload         = "CompleteMultipartUpload"
	opAbortMultipartUpload            = "AbortMultipartUpload"
	opListParts                       = "ListParts"
	opListMultipartUploads            = "ListMultipartUploads"
	opListObjects                     = "ListObjects"
	opListBuckets                     = "ListBuckets"
	opGetObject                       = "GetObject"
	opHeadObject                      = "HeadObject"
	opHeadBucket                      = "HeadBucket"
	opDeleteObject                    = "DeleteObject"
	opDeleteObjects                   = "DeleteObjects"
	opDeleteBucket                    = "DeleteBucket"
	opGetBucketLocation               = "GetBucketLocation"
	opGetBucketCors                   = "GetBucketCors"
	opPutBucketCors                   = "PutBucketCors"
	opDeleteBucketCors                = "DeleteBucketCors"
	opGetBucketEncryption             = "GetBucketEncryption"
	opPutBucketEncryption             = "PutBucketEncryption"
	opGetBucketLifecycleConfiguration = "GetBucketLifecycleConfiguration"
	opPutBucketLifecycleConfiguration = "PutBucketLifecycleConfiguration"
	opOther                           = "Other"
)

// classify names the S3 operation a request performs and the class R2 bills
// it as.
//
// The classes come from Cloudflare's pricing page, which prices Class A more
// than ten times Class B and bills neither for deletes. Three points on it
// are worth keeping in mind while reading this, because they are what makes
// the media pipeline's bill what it is: every part of a multipart upload is
// its own Class A operation, so the client's part size decides how many
// writes one segment costs; every page of a listing is its own Class A
// operation, so reclaiming a room costs a request per thousand objects; and
// deletes are free, so reclaiming is otherwise as cheap as leaving the
// objects to the bucket's lifecycle rule.
//
// Anything the pricing page does not name is reported as unknown rather than
// guessed into a billed class. A cost panel that quietly invents operations
// is worse than one with a gap in it, because only the gap prompts anyone to
// go and check.
func classify(request *http.Request, bucket string) (operation, class string) {
	query := request.URL.Query()
	_, key := splitBucketKey(request, bucket)
	object := key != ""

	switch request.Method {
	case http.MethodPut:
		switch {
		case query.Has("uploadId") && query.Has("partNumber"):
			if request.Header.Get("x-amz-copy-source") != "" {
				return opUploadPartCopy, metrics.ClassA
			}
			return opUploadPart, metrics.ClassA
		case query.Has("cors"):
			return opPutBucketCors, metrics.ClassA
		case query.Has("lifecycle"):
			return opPutBucketLifecycleConfiguration, metrics.ClassA
		case query.Has("encryption"):
			return opPutBucketEncryption, metrics.ClassA
		case request.Header.Get("x-amz-copy-source") != "":
			return opCopyObject, metrics.ClassA
		case !object:
			return opCreateBucket, metrics.ClassA
		default:
			return opPutObject, metrics.ClassA
		}

	case http.MethodPost:
		switch {
		case query.Has("uploads"):
			return opCreateMultipartUpload, metrics.ClassA
		case query.Has("uploadId"):
			return opCompleteMultipartUpload, metrics.ClassA
		case query.Has("delete"):
			// Not named on the pricing page, but the page's own billing
			// example says deletes are free and the batch form is the same
			// operation applied to many keys at once.
			return opDeleteObjects, metrics.ClassFree
		}

	case http.MethodGet:
		switch {
		case query.Has("uploadId"):
			return opListParts, metrics.ClassA
		case query.Has("uploads"):
			return opListMultipartUploads, metrics.ClassA
		case query.Has("location"):
			return opGetBucketLocation, metrics.ClassB
		case query.Has("cors"):
			return opGetBucketCors, metrics.ClassB
		case query.Has("lifecycle"):
			return opGetBucketLifecycleConfiguration, metrics.ClassB
		case query.Has("encryption"):
			return opGetBucketEncryption, metrics.ClassB
		case query.Has("list-type") || query.Has("prefix") || query.Has("delimiter") ||
			query.Has("marker") || query.Has("continuation-token"):
			// ListObjectsV2 is what the client actually sends and the pricing
			// page only names ListObjects. They are one operation with two
			// wire formats, so they are counted as one.
			return opListObjects, metrics.ClassA
		case object:
			return opGetObject, metrics.ClassB
		case isRootPath(request):
			return opListBuckets, metrics.ClassA
		default:
			return opListObjects, metrics.ClassA
		}

	case http.MethodHead:
		if object {
			return opHeadObject, metrics.ClassB
		}
		return opHeadBucket, metrics.ClassB

	case http.MethodDelete:
		switch {
		case query.Has("uploadId"):
			return opAbortMultipartUpload, metrics.ClassFree
		case query.Has("cors"):
			// Implemented by R2 but absent from all three pricing lists.
			return opDeleteBucketCors, metrics.ClassUnknown
		case object:
			return opDeleteObject, metrics.ClassFree
		default:
			return opDeleteBucket, metrics.ClassFree
		}
	}
	return opOther, metrics.ClassUnknown
}

// splitBucketKey reports which bucket and object a request addresses, under
// either addressing style. The client picks the style itself, so both have to
// be understood here: with a virtual-hosted bucket the whole path is the key,
// and with a path-style one the first segment is the bucket.
func splitBucketKey(request *http.Request, bucket string) (string, string) {
	path := strings.TrimPrefix(request.URL.EscapedPath(), "/")
	if bucket != "" && strings.HasPrefix(request.URL.Host, bucket+".") {
		return bucket, path
	}
	name, key, _ := strings.Cut(path, "/")
	return name, key
}

func isRootPath(request *http.Request) bool {
	return strings.Trim(request.URL.EscapedPath(), "/") == ""
}

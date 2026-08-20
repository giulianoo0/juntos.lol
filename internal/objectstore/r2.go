package objectstore

import (
	"context"
	"fmt"
	"io"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// R2 stores objects in a Cloudflare R2 bucket over the S3 API.
type R2 struct {
	client *minio.Client
	bucket string
}

// R2Config is what an R2 bucket needs to be written to. Every field is
// required: a half-configured bucket is a room that fails halfway through.
type R2Config struct {
	AccountID string
	Bucket    string
	AccessKey string
	SecretKey string
}

// NewR2 dials an R2 bucket. It does not verify the credentials — that costs a
// round trip at every boot, and the first upload reports the same failure.
func NewR2(cfg R2Config) (*R2, error) {
	if cfg.AccountID == "" || cfg.Bucket == "" || cfg.AccessKey == "" || cfg.SecretKey == "" {
		return nil, fmt.Errorf("objectstore: account id, bucket, access key and secret key are all required")
	}
	endpoint := cfg.AccountID + ".r2.cloudflarestorage.com"
	client, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure: true,
		// R2 ignores the region but the S3 signature does not: it is part of
		// the signing scope, and "auto" is what R2 expects to sign against.
		Region: "auto",
	})
	if err != nil {
		return nil, fmt.Errorf("objectstore: dial R2: %w", err)
	}
	return &R2{client: client, bucket: cfg.Bucket}, nil
}

// singlePartSize is the size below which an object is written with one
// request.
//
// The client's own default is 16 MiB, and past it an upload becomes
// CreateMultipartUpload plus one UploadPart per chunk plus
// CompleteMultipartUpload — every one of them a billed write, and every one of
// them a round trip to the bucket. Media segments run to tens of megabytes at
// most, so raising the threshold to something none of them reach makes each
// one cost the single write it is. Anything genuinely larger still splits,
// which is what keeps a huge object recoverable.
const singlePartSize = 128 * 1024 * 1024

func putOptions(contentType, cacheControl string) minio.PutObjectOptions {
	return minio.PutObjectOptions{
		ContentType:  contentType,
		CacheControl: cacheControl,
		PartSize:     singlePartSize,
	}
}

func (r *R2) Put(ctx context.Context, key string, reader io.Reader, size int64,
	contentType, cacheControl string) error {
	_, err := r.client.PutObject(ctx, r.bucket, key, reader, size,
		putOptions(contentType, cacheControl))
	if err != nil {
		return fmt.Errorf("objectstore: put %s: %w", key, err)
	}
	return nil
}

// RemovePrefix deletes every object under prefix.
//
// Listing is a billed write operation and deleting is free, so the cost of
// this is one request per thousand objects — nothing against the storage a
// finished room would otherwise hold until the bucket's own lifecycle rule
// caught up with it.
func (r *R2) RemovePrefix(ctx context.Context, prefix string) error {
	if prefix == "" {
		return ErrEmptyPrefix
	}
	listed := r.client.ListObjects(ctx, r.bucket, minio.ListObjectsOptions{
		Prefix:    prefix,
		Recursive: true,
	})
	// A failed listing must not read as an empty one: the deletes would report
	// success having removed only what was listed before the error.
	var listErr error
	keys := make(chan minio.ObjectInfo)
	go func() {
		defer close(keys)
		for object := range listed {
			if object.Err != nil {
				listErr = object.Err
				return
			}
			select {
			case keys <- object:
			case <-ctx.Done():
				listErr = ctx.Err()
				return
			}
		}
	}()
	for failure := range r.client.RemoveObjects(ctx, r.bucket, keys, minio.RemoveObjectsOptions{}) {
		if failure.Err != nil {
			return fmt.Errorf("objectstore: remove %s: %w", failure.ObjectName, failure.Err)
		}
	}
	// Safe to read unsynchronized: the goroutine closes keys before returning,
	// and RemoveObjects only closes its own channel once keys is drained.
	if listErr != nil {
		return fmt.Errorf("objectstore: list %s: %w", prefix, listErr)
	}
	return nil
}

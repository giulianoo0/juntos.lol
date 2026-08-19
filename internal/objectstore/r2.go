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

func (r *R2) Put(ctx context.Context, key string, reader io.Reader, size int64,
	contentType, cacheControl string) error {
	_, err := r.client.PutObject(ctx, r.bucket, key, reader, size, minio.PutObjectOptions{
		ContentType:  contentType,
		CacheControl: cacheControl,
	})
	if err != nil {
		return fmt.Errorf("objectstore: put %s: %w", key, err)
	}
	return nil
}

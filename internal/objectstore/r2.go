package objectstore

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

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
	Endpoint  string
	Insecure  bool
}

// NewR2 dials an R2 bucket. It does not verify the credentials — that costs a
// round trip at every boot, and the first upload reports the same failure.
func NewR2(cfg R2Config) (*R2, error) {
	if cfg.AccountID == "" || cfg.Bucket == "" || cfg.AccessKey == "" || cfg.SecretKey == "" {
		return nil, fmt.Errorf("objectstore: account id, bucket, access key and secret key are all required")
	}
	endpoint := cfg.Endpoint
	secure := !cfg.Insecure
	if endpoint == "" {
		endpoint = cfg.AccountID + ".r2.cloudflarestorage.com"
		secure = true
	}
	transport, err := minio.DefaultTransport(secure)
	if err != nil {
		return nil, fmt.Errorf("objectstore: build R2 transport: %w", err)
	}
	client, err := minio.New(endpoint, &minio.Options{
		Creds:     credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure:    secure,
		Region:    "auto",
		Transport: transport,
	})
	if err != nil {
		return nil, fmt.Errorf("objectstore: dial R2: %w", err)
	}
	return &R2{client: client, bucket: cfg.Bucket}, nil
}

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

// Stat reports the size of the object under key, which is how a browser's
// claim that it uploaded a segment is checked without reading the bytes back.
func (r *R2) Stat(ctx context.Context, key string) (int64, error) {
	info, err := r.client.StatObject(ctx, r.bucket, key, minio.StatObjectOptions{})
	if err != nil {
		return 0, fmt.Errorf("objectstore: stat %s: %w", key, err)
	}
	return info.Size, nil
}

// PresignPut signs a PUT for key that a browser can use directly. Content
// type, cache control and the exact byte length are pinned into the signature,
// so the client's body cannot be larger or smaller than what was signed for.
func (r *R2) PresignPut(ctx context.Context, key, contentType, cacheControl string,
	size int64, expiry time.Duration) (string, http.Header, error) {
	headers := http.Header{
		"Content-Type":   []string{contentType},
		"Cache-Control":  []string{cacheControl},
		"Content-Length": []string{strconv.FormatInt(size, 10)},
	}
	signed, err := r.client.PresignHeader(ctx, http.MethodPut, r.bucket, key, expiry, url.Values{}, headers)
	if err != nil {
		return "", nil, fmt.Errorf("objectstore: presign %s: %w", key, err)
	}
	return signed.String(), headers, nil
}

func (r *R2) RemovePrefix(ctx context.Context, prefix string) error {
	if prefix == "" {
		return ErrEmptyPrefix
	}
	listed := r.client.ListObjects(ctx, r.bucket, minio.ListObjectsOptions{
		Prefix:    prefix,
		Recursive: true,
	})
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
	if listErr != nil {
		return fmt.Errorf("objectstore: list %s: %w", prefix, listErr)
	}
	return nil
}

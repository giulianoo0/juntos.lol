package media

import (
	"crypto/sha256"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/objectstore"
	"github.com/giulianoo0/ss/internal/room"
)

const publicBase = "https://media.example.test"

func newPublisherFixture(t *testing.T) (*Publisher, *objectstore.Fake, *room.Store) {
	t.Helper()
	mr := miniredis.RunT(t)
	store := room.NewStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}), time.Hour)
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "r1", Status: "processing", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
	bucket := objectstore.NewFake()
	return NewPublisher(store, bucket, publicBase), bucket, store
}

func appendToFile(t *testing.T, path, text string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	require.NoError(t, err)
	_, err = f.WriteString(text)
	require.NoError(t, err)
	require.NoError(t, f.Close())
}

func TestPublisherUploadsSubtitles(t *testing.T) {
	publisher, bucket, _ := newPublisherFixture(t)
	subsDir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(subsDir, "sub_0_por.vtt"), []byte("WEBVTT\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(subsDir, "notes.txt"), []byte("ignored"), 0o644))

	require.NoError(t, publisher.PublishSubtitles(t.Context(), "r1", subsDir))

	track, ok := bucket.Get("rooms/r1/g0/subs/sub_0_por.vtt")
	require.True(t, ok)
	require.Equal(t, "text/vtt; charset=utf-8", track.ContentType)
	require.Equal(t, subtitleCacheControl, track.CacheControl)
	require.Len(t, bucket.Keys(), 1, "only WebVTT belongs in the subtitle prefix")
}

func TestPublisherSendsOnlyTheSubtitlesThatChanged(t *testing.T) {
	publisher, bucket, _ := newPublisherFixture(t)
	subsDir := t.TempDir()
	ended := filepath.Join(subsDir, "sub_0_por.vtt")
	growing := filepath.Join(subsDir, "sub_1_eng.vtt")
	require.NoError(t, os.WriteFile(ended,
		[]byte("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\noi\n"), 0o644))
	require.NoError(t, os.WriteFile(growing,
		[]byte("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi\n"), 0o644))

	require.NoError(t, publisher.PublishSubtitles(t.Context(), "r1", subsDir))
	appendToFile(t, growing, "\n00:10:00.000 --> 00:10:02.000\nlater\n")
	require.NoError(t, publisher.PublishSubtitles(t.Context(), "r1", subsDir))

	// A progressive snapshot rewrites every track's file on every tick, so a
	// track whose cues ran out arrives here byte for byte identical each time.
	// Sending it again costs a billed write per track per tick and changes
	// nothing a viewer would fetch.
	require.Equal(t, 1, bucket.Puts("rooms/r1/g0/subs/sub_0_por.vtt"))
	require.Equal(t, 2, bucket.Puts("rooms/r1/g0/subs/sub_1_eng.vtt"))
	object, ok := bucket.Get("rooms/r1/g0/subs/sub_1_eng.vtt")
	require.True(t, ok)
	require.Contains(t, string(object.Body), "later")
}

func TestPublisherResendsSubtitlesAfterASourceSwap(t *testing.T) {
	// A new source writes the same track names to a prefix of its own, and
	// nothing has ever been uploaded under those keys.
	publisher, bucket, store := newPublisherFixture(t)
	subsDir := t.TempDir()
	track := filepath.Join(subsDir, "sub_0_eng.vtt")
	require.NoError(t, os.WriteFile(track,
		[]byte("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi\n"), 0o644))
	require.NoError(t, publisher.PublishSubtitles(t.Context(), "r1", subsDir))

	_, generation, err := store.SwapSource(t.Context(), "r1", "upload", "next.mkv", "uploading", time.Now())
	require.NoError(t, err)
	require.Equal(t, 1, generation)
	require.NoError(t, publisher.PublishSubtitles(t.Context(), "r1", subsDir))

	require.Equal(t, 1, bucket.Puts("rooms/r1/g1/subs/sub_0_eng.vtt"))
}

func TestPublisherForgetsUploadedSubtitlesOnceTheyPileUp(t *testing.T) {
	// The record of what was already sent lives for the life of the process,
	// so it needs a ceiling. Forgetting everything costs one redundant upload
	// per track still being extracted, which is cheaper than a map that only
	// ever grows.
	publisher, _, _ := newPublisherFixture(t)
	for i := range maxRememberedSubtitles + 1 {
		publisher.rememberSubtitle("rooms/r"+strconv.Itoa(i)+"/g0/subs/sub_0_eng.vtt", [sha256.Size]byte{})
	}
	require.LessOrEqual(t, publisher.rememberedSubtitles(), maxRememberedSubtitles)
}

func TestPublisherSubtitleDirectoryMayNotExistYet(t *testing.T) {
	publisher, _, _ := newPublisherFixture(t)
	require.NoError(t, publisher.PublishSubtitles(t.Context(), "r1", filepath.Join(t.TempDir(), "absent")))
}

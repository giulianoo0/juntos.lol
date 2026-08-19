package media

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/objectstore"
	"github.com/giulianoo0/ss/internal/room"
)

const publicBase = "https://media.example.test"

func newPublisherFixture(t *testing.T) (*Publisher, *objectstore.Fake, *room.Store, string) {
	t.Helper()
	mr := miniredis.RunT(t)
	store := room.NewStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}), time.Hour)
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "r1", Status: "processing", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
	bucket := objectstore.NewFake()
	hlsDir := t.TempDir()
	return NewPublisher(store, bucket, publicBase), bucket, store, hlsDir
}

// writePlaylist lays out a media playlist plus the files it names. Segments
// listed beyond present are left off disk, standing in for output the muxer
// has written the entry for but not yet renamed into place.
func writePlaylist(t *testing.T, hlsDir, name string, segments int, present int, endlist bool) {
	t.Helper()
	require.NoError(t, os.WriteFile(filepath.Join(hlsDir, "preview_init_0.mp4"), []byte("init"), 0o644))
	body := strings.Builder{}
	body.WriteString("#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n")
	body.WriteString("#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n")
	body.WriteString("#EXT-X-MAP:URI=\"preview_init_0.mp4\"\n")
	for i := range segments {
		segment := segmentName(i)
		body.WriteString("#EXTINF:2.000000,\n" + segment + "\n")
		if i < present {
			require.NoError(t, os.WriteFile(filepath.Join(hlsDir, segment), []byte("seg"), 0o644))
		}
	}
	if endlist {
		body.WriteString("#EXT-X-ENDLIST\n")
	}
	require.NoError(t, os.WriteFile(filepath.Join(hlsDir, name), []byte(body.String()), 0o644))
}

func segmentName(i int) string {
	return "preview_stream_0_00000" + string(rune('0'+i)) + ".m4s"
}

func TestPublisherUploadsSegmentsAndPublishesThePlaylist(t *testing.T) {
	publisher, bucket, store, hlsDir := newPublisherFixture(t)
	writePlaylist(t, hlsDir, "preview_stream_0.m3u8", 2, 2, true)

	require.NoError(t, publisher.Publish(t.Context(), "r1", hlsDir, []string{"preview_stream_*.m3u8"}))

	segment, ok := bucket.Get("rooms/r1/g0/hls/" + segmentName(0))
	require.True(t, ok, "first segment should be in the bucket")
	require.Equal(t, "seg", string(segment.Body))
	require.Equal(t, immutableCacheControl, segment.CacheControl)

	init, ok := bucket.Get("rooms/r1/g0/hls/preview_init_0.mp4")
	require.True(t, ok, "init segment should be in the bucket")
	require.Equal(t, "video/mp4", init.ContentType)

	published, err := store.Playlist(t.Context(), "r1", "preview_stream_0.m3u8")
	require.NoError(t, err)
	require.Contains(t, published, publicBase+"/rooms/r1/g0/hls/"+segmentName(0))
	require.Contains(t, published, `#EXT-X-MAP:URI="`+publicBase+`/rooms/r1/g0/hls/preview_init_0.mp4"`)
	require.Contains(t, published, "#EXT-X-ENDLIST")
}

func TestPublisherReclaimsDiskForUploadedSegmentsButKeepsInitFiles(t *testing.T) {
	publisher, _, _, hlsDir := newPublisherFixture(t)
	writePlaylist(t, hlsDir, "preview_stream_0.m3u8", 2, 2, true)

	require.NoError(t, publisher.Publish(t.Context(), "r1", hlsDir, []string{"preview_stream_*.m3u8"}))

	require.NoFileExists(t, filepath.Join(hlsDir, segmentName(0)))
	require.NoFileExists(t, filepath.Join(hlsDir, segmentName(1)))
	// The codec annotation pass reads the video init segment to write an HEVC
	// label, so init files must survive the upload that copies them.
	require.FileExists(t, filepath.Join(hlsDir, "preview_init_0.mp4"))
}

func TestPublisherStopsThePlaylistAtTheLastConfirmedSegment(t *testing.T) {
	publisher, _, store, hlsDir := newPublisherFixture(t)
	writePlaylist(t, hlsDir, "preview_stream_0.m3u8", 3, 2, true)

	require.NoError(t, publisher.Publish(t.Context(), "r1", hlsDir, []string{"preview_stream_*.m3u8"}))

	published, err := store.Playlist(t.Context(), "r1", "preview_stream_0.m3u8")
	require.NoError(t, err)
	require.Contains(t, published, segmentName(1))
	require.NotContains(t, published, segmentName(2),
		"a segment that is not in the bucket must not be offered to a viewer")
	require.NotContains(t, published, "#EXT-X-ENDLIST",
		"a truncated playlist must not claim the episode has finished")
	require.Equal(t, 2, strings.Count(published, "#EXTINF"),
		"the tag describing the missing segment belongs to that segment")
}

func TestPublisherWithholdsAPlaylistUntilItsInitSegmentLands(t *testing.T) {
	publisher, _, store, hlsDir := newPublisherFixture(t)
	writePlaylist(t, hlsDir, "preview_stream_0.m3u8", 1, 1, false)
	require.NoError(t, os.Remove(filepath.Join(hlsDir, "preview_init_0.mp4")))

	require.NoError(t, publisher.Publish(t.Context(), "r1", hlsDir, []string{"preview_stream_*.m3u8"}))

	_, err := store.Playlist(t.Context(), "r1", "preview_stream_0.m3u8")
	require.ErrorIs(t, err, room.ErrNotFound, "nothing in the playlist decodes without its init segment")
}

func TestPublisherLeavesTheMasterPointingAtVariantPlaylists(t *testing.T) {
	publisher, bucket, store, hlsDir := newPublisherFixture(t)
	master := "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\npreview_stream_0.m3u8\n"
	require.NoError(t, os.WriteFile(filepath.Join(hlsDir, "master.m3u8"), []byte(master), 0o644))

	require.NoError(t, publisher.Publish(t.Context(), "r1", hlsDir, []string{"master.m3u8"}))

	published, err := store.Playlist(t.Context(), "r1", "master.m3u8")
	require.NoError(t, err)
	require.Equal(t, master, published, "variant playlists are served by the application, not the bucket")
	require.Empty(t, bucket.Keys(), "a master playlist references no objects")
}

func TestPublisherFailsWhenTheBucketRefusesASegment(t *testing.T) {
	publisher, bucket, store, hlsDir := newPublisherFixture(t)
	writePlaylist(t, hlsDir, "preview_stream_0.m3u8", 2, 2, true)
	bucket.SetFailOn(func(key string) bool { return strings.HasSuffix(key, segmentName(1)) })

	err := publisher.Publish(t.Context(), "r1", hlsDir, []string{"preview_stream_*.m3u8"})

	require.Error(t, err, "media has no disk fallback, so a refused upload must fail the job")
	_, err = store.Playlist(t.Context(), "r1", "preview_stream_0.m3u8")
	require.ErrorIs(t, err, room.ErrNotFound)
}

func TestPublisherSkipsObjectsAlreadyInTheBucket(t *testing.T) {
	publisher, bucket, _, hlsDir := newPublisherFixture(t)
	writePlaylist(t, hlsDir, "preview_stream_0.m3u8", 2, 2, true)
	require.NoError(t, publisher.Publish(t.Context(), "r1", hlsDir, []string{"preview_stream_*.m3u8"}))

	// The segments are gone from disk now, so a second pass that tried to
	// re-upload them would fail rather than quietly repeat work.
	bucket.SetFailOn(func(string) bool { return true })
	require.NoError(t, publisher.Publish(t.Context(), "r1", hlsDir, []string{"preview_stream_*.m3u8"}))
}

func TestPublisherUploadsSubtitles(t *testing.T) {
	publisher, bucket, _, _ := newPublisherFixture(t)
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

func TestPublisherSubtitleDirectoryMayNotExistYet(t *testing.T) {
	publisher, _, _, _ := newPublisherFixture(t)
	require.NoError(t, publisher.PublishSubtitles(t.Context(), "r1", filepath.Join(t.TempDir(), "absent")))
}

// testPublisher wires a publisher to an in-memory bucket for tests whose
// subject is something else.
func testPublisher(store *room.Store) *Publisher {
	return NewPublisher(store, objectstore.NewFake(), publicBase)
}

func TestPublisherKeepsGoingAfterAFailedPass(t *testing.T) {
	// Giving up on the first failure would freeze a preview at its last
	// confirmed segment for the rest of the encode, and nothing downstream
	// would notice: this loop only logs.
	publisher, bucket, store, hlsDir := newPublisherFixture(t)
	publisher.interval = 5 * time.Millisecond
	writePlaylist(t, hlsDir, "preview_stream_0.m3u8", 2, 2, true)
	bucket.SetFailOn(func(string) bool { return true })

	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() {
		defer close(done)
		publisher.Run(ctx, "r1", hlsDir, []string{"preview_stream_*.m3u8"})
	}()
	t.Cleanup(func() { cancel(); <-done })

	time.Sleep(30 * time.Millisecond)
	_, err := store.Playlist(t.Context(), "r1", "preview_stream_0.m3u8")
	require.ErrorIs(t, err, room.ErrNotFound, "a refusing bucket publishes nothing")

	bucket.SetFailOn(nil)

	require.Eventually(t, func() bool {
		_, err := store.Playlist(t.Context(), "r1", "preview_stream_0.m3u8")
		return err == nil
	}, 2*time.Second, 10*time.Millisecond, "a recovered bucket should be published to again")
}

func TestPublisherRecordsWhatReachedTheBucketBeforeFailing(t *testing.T) {
	// A retry should pay for the objects still missing, not for all of them.
	publisher, bucket, store, hlsDir := newPublisherFixture(t)
	writePlaylist(t, hlsDir, "preview_stream_0.m3u8", 2, 2, true)
	bucket.SetFailOn(func(key string) bool { return strings.HasSuffix(key, segmentName(1)) })

	require.Error(t, publisher.Publish(t.Context(), "r1", hlsDir, []string{"preview_stream_*.m3u8"}))

	published, err := store.Published(t.Context(), "r1")
	require.NoError(t, err)
	require.Contains(t, published, "preview_init_0.mp4")
	require.Contains(t, published, segmentName(0))
	require.NotContains(t, published, segmentName(1))
}

func TestPublisherMovesToANewPrefixAfterASourceSwap(t *testing.T) {
	// Segment names repeat across sources, and their URLs are handed to the
	// edge as immutable for a year. Reusing a key would serve the previous
	// video from cache, with nothing the application could do to correct it.
	publisher, bucket, store, hlsDir := newPublisherFixture(t)
	writePlaylist(t, hlsDir, "preview_stream_0.m3u8", 1, 1, true)
	require.NoError(t, publisher.Publish(t.Context(), "r1", hlsDir, []string{"preview_stream_*.m3u8"}))
	require.Contains(t, bucket.Keys(), "rooms/r1/g0/hls/"+segmentName(0))

	_, generation, err := store.SwapSource(t.Context(), "r1", "upload", "next.mkv", "uploading", time.Now())
	require.NoError(t, err)
	require.Equal(t, 1, generation)

	// The next source writes the same names into the same directory.
	writePlaylist(t, hlsDir, "preview_stream_0.m3u8", 1, 1, true)
	require.NoError(t, publisher.Publish(t.Context(), "r1", hlsDir, []string{"preview_stream_*.m3u8"}))

	require.Contains(t, bucket.Keys(), "rooms/r1/g1/hls/"+segmentName(0),
		"the new source must land on keys of its own")
	published, err := store.Playlist(t.Context(), "r1", "preview_stream_0.m3u8")
	require.NoError(t, err)
	require.Contains(t, published, "/rooms/r1/g1/hls/")
	require.NotContains(t, published, "/rooms/r1/g0/hls/")
}

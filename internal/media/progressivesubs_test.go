package media

import (
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

func TestBuildProgressiveSubtitleArgsWritesOnePerTrack(t *testing.T) {
	probe := &ProbeResult{Subtitles: []room.TrackInfo{
		{Index: 0, Language: "eng"},
		{Index: 2, Language: "por"},
	}}

	args, outputs := buildProgressiveSubtitleArgs("pipe:0", "/tmp/subs", probe)
	joined := strings.Join(args, " ")

	// The stream index comes from the probe, the file name from the position:
	// the player asks for tracks by their place in the room's list.
	require.Contains(t, joined, "-map 0:s:0")
	require.Contains(t, joined, "-map 0:s:2")
	require.Equal(t, []string{"/tmp/subs/sub_0_eng.vtt", "/tmp/subs/sub_1_por.vtt"}, outputs)
	// Without this ffmpeg holds cues back for minutes, which defeats the point.
	require.Contains(t, joined, "-flush_packets 1")
}

func TestPublishSubtitleSnapshotRepublishesWhenCuesGrow(t *testing.T) {
	mr := miniredis.RunT(t)
	store := room.NewStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}), time.Hour)
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "r1", Status: "processing", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
	bucket := objectstore.NewFake()
	dataDir := t.TempDir()
	p := &Progressive{
		store:     store,
		dataDir:   dataDir,
		publisher: NewPublisher(store, bucket, "https://media.example.test"),
	}

	subsDir := filepath.Join(dataDir, "rooms", "r1", "subs")
	require.NoError(t, os.MkdirAll(subsDir, 0o755))
	output := filepath.Join(subsDir, "sub_0_eng.vtt")
	require.NoError(t, os.WriteFile(output,
		[]byte("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nfirst\n"), 0o644))

	probe := &ProbeResult{Subtitles: []room.TrackInfo{{Index: 0, Language: "eng"}}}
	var published subtitleSnapshot
	p.publishSubtitleSnapshot(t.Context(), t.Context(), "r1", probe, []string{output}, &published)

	// New cues landing in an already-published track must reach viewers: the
	// player refetches only on a version bump, so a snapshot that never
	// republishes freezes everyone at the first few minutes of cues.
	appendToFile(t, output, "\n00:10:00.000 --> 00:10:02.000\nlater\n")
	p.publishSubtitleSnapshot(t.Context(), t.Context(), "r1", probe, []string{output}, &published)

	stored, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, 2, stored.SubsVersion)
	object, ok := bucket.Get("rooms/r1/g0/subs/sub_0_eng.vtt")
	require.True(t, ok)
	require.Contains(t, string(object.Body), "later")
}

func appendToFile(t *testing.T, path, content string) {
	t.Helper()
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	require.NoError(t, err)
	_, err = file.WriteString(content)
	require.NoError(t, err)
	require.NoError(t, file.Close())
}

func TestHasSubtitleCuesIgnoresAHeaderWithNothingUnderIt(t *testing.T) {
	dir := t.TempDir()
	empty := filepath.Join(dir, "empty.vtt")
	require.NoError(t, os.WriteFile(empty, []byte("WEBVTT\n\n"), 0o644))
	// ffmpeg writes the header the moment it opens the file, so publishing on
	// existence alone would offer viewers a track with no cues in it.
	require.False(t, hasSubtitleCues(empty))

	withCue := filepath.Join(dir, "one.vtt")
	require.NoError(t, os.WriteFile(withCue,
		[]byte("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nolá\n"), 0o644))
	require.True(t, hasSubtitleCues(withCue))

	require.False(t, hasSubtitleCues(filepath.Join(dir, "missing.vtt")))
}

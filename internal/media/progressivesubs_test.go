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

func TestBuildProgressiveSubtitleArgsWritesOnePerTrack(t *testing.T) {
	probe := &ProbeResult{Subtitles: []room.TrackInfo{
		{Index: 0, Language: "eng", Codec: "subrip"},
		{Index: 2, Language: "por", Codec: "subrip"},
	}}

	args, outputs := buildProgressiveSubtitleArgs("pipe:0", "/tmp/subs", probe)
	joined := strings.Join(args, " ")

	// The stream index comes from the probe, the file name from the position:
	// the player asks for tracks by their place in the room's list.
	require.Contains(t, joined, "-map 0:s:0")
	require.Contains(t, joined, "-map 0:s:2")
	// Plain tracks grow as work files: each snapshot positions the dialogue
	// and writes the .vtt players actually fetch.
	require.Equal(t, []string{"/tmp/subs/sub_0_eng.vtt.src", "/tmp/subs/sub_1_por.vtt.src"}, outputs)
	require.Contains(t, joined, "-f webvtt")
	// Without this ffmpeg holds cues back for minutes, which defeats the point.
	require.Contains(t, joined, "-flush_packets 1")
}

func TestBuildProgressiveSubtitleArgsGrowsStyledTracksAsASS(t *testing.T) {
	probe := &ProbeResult{Subtitles: []room.TrackInfo{{Index: 0, Language: "eng", Codec: "ass"}}}

	args, outputs := buildProgressiveSubtitleArgs("pipe:0", "/tmp/subs", probe)

	// A styled track grows as the script whose placement and color the
	// snapshot conversion keeps; ffmpeg's webvtt encoder would drop them.
	require.Equal(t, []string{"/tmp/subs/sub_0_eng.ass"}, outputs)
	require.Contains(t, strings.Join(args, " "), "-c:s ass")
}

func TestPublishSubtitleSnapshotPositionsAGrowingPlainTrack(t *testing.T) {
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
	output := filepath.Join(subsDir, "sub_0_eng.vtt.src")
	require.NoError(t, os.WriteFile(output,
		[]byte("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nfala\n"), 0o644))
	probe := &ProbeResult{Subtitles: []room.TrackInfo{{Index: 0, Language: "eng", Codec: "subrip"}}}

	var published subtitleSnapshot
	p.publishSubtitleSnapshot(t.Context(), t.Context(), "r1", probe, []string{output}, &published)

	object, ok := bucket.Get("rooms/r1/g0/subs/sub_0_eng.vtt")
	require.True(t, ok)
	require.Contains(t, string(object.Body), "00:00:01.000 --> 00:00:02.000 line:-3\nfala")
}

func TestPublishSubtitleSnapshotConvertsAGrowingStyledTrack(t *testing.T) {
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
	output := filepath.Join(subsDir, "sub_0_eng.ass")
	require.NoError(t, os.WriteFile(output, []byte(
		"[V4+ Styles]\n"+
			"Format: Name, PrimaryColour, Bold, Italic, Alignment\n"+
			"Style: Signs,&H0000FFFF,0,0,8\n"+
			"[Events]\n"+
			"Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"+
			"Dialogue: 0,0:00:01.00,0:00:02.00,Signs,,0,0,0,,placa\n"), 0o644))
	probe := &ProbeResult{Subtitles: []room.TrackInfo{{Index: 0, Language: "eng", Codec: "ass"}}}

	var published subtitleSnapshot
	p.publishSubtitleSnapshot(t.Context(), t.Context(), "r1", probe, []string{output}, &published)

	// The bucket gets the converted VTT under the name players ask for, with
	// the placement and color the script carried.
	object, ok := bucket.Get("rooms/r1/g0/subs/sub_0_eng.vtt")
	require.True(t, ok)
	require.Contains(t, string(object.Body), "line:5%\n<c.yellow>placa</c>")
	stored, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, 1, stored.SubsVersion)
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

func TestSubtitleSnapshotsSpaceOutAsTheExtractionRunsOn(t *testing.T) {
	// The first snapshot is what makes a room's subtitles exist at all, so it
	// comes quickly. Each one after that publishes cues further ahead of where
	// anyone is watching, and costs a republish that sends every connected
	// player back for every track. The wrap-up publish covers the ending
	// whatever the interval reached, so widening it delays nothing at the end.
	require.Equal(t, 6*time.Second, nextSubtitleInterval(0))
	require.Equal(t, 12*time.Second, nextSubtitleInterval(6*time.Second))
	require.Equal(t, 48*time.Second, nextSubtitleInterval(24*time.Second))
	require.Equal(t, maxSubtitleSnapshotInterval, nextSubtitleInterval(48*time.Second))
	require.Equal(t, maxSubtitleSnapshotInterval, nextSubtitleInterval(time.Hour))
}

func TestSubtitleWrapUpSurvivesTheJobContextDying(t *testing.T) {
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
		[]byte("WEBVTT\n\n00:23:00.000 --> 00:23:02.000\nthe ending\n"), 0o644))
	probe := &ProbeResult{Subtitles: []room.TrackInfo{{Index: 0, Language: "eng"}}}

	// The final remux cancels the progressive job the moment the source
	// finishes arriving — which is exactly when the last cues land on disk.
	// A wrap-up that dies with that context loses the ending for everyone.
	canceledCtx, cancel := context.WithCancel(t.Context())
	cancel()
	var published subtitleSnapshot
	p.wrapUpSubtitles(t.Context(), canceledCtx, "r1", 0, probe, []string{output}, &published)

	stored, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, 1, stored.SubsVersion)
	object, ok := bucket.Get("rooms/r1/g0/subs/sub_0_eng.vtt")
	require.True(t, ok)
	require.Contains(t, string(object.Body), "the ending")
}

func TestSubtitleWrapUpSkipsARoomOnAnotherSource(t *testing.T) {
	mr := miniredis.RunT(t)
	store := room.NewStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}), time.Hour)
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "r1", Status: "processing", MediaGeneration: 1,
		CreatedAt: now, ExpiresAt: now.Add(time.Hour),
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
		[]byte("WEBVTT\n\n00:23:00.000 --> 00:23:02.000\nstale\n"), 0o644))
	probe := &ProbeResult{Subtitles: []room.TrackInfo{{Index: 0, Language: "eng"}}}

	// The job context also dies when the room swaps to another video. Cues
	// read from the replaced source must never be published over the new one.
	var published subtitleSnapshot
	p.wrapUpSubtitles(t.Context(), t.Context(), "r1", 0, probe, []string{output}, &published)

	stored, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, 0, stored.SubsVersion)
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

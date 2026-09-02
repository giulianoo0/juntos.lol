package room

import (
	"context"
	"fmt"
	"strconv"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

func TestCreateGetRoundTrip(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	s := NewStore(rdb, 5*time.Hour)
	r := &Room{ID: "abc", FileName: "movie.mkv", Status: "uploading",
		ControllerID: "m1", CreatedAt: time.Now(), ExpiresAt: time.Now().Add(5 * time.Hour)}
	require.NoError(t, s.Create(context.Background(), r))
	got, err := s.Get(context.Background(), "abc")
	require.NoError(t, err)
	require.Equal(t, "movie.mkv", got.FileName)
	require.Equal(t, "uploading", got.Status)
	ttl := mr.TTL("room:abc")
	require.Greater(t, ttl, 4*time.Hour)
}

func TestSetChaptersRoundTripsAndSwapClearsThem(t *testing.T) {
	mr := miniredis.RunT(t)
	s := NewStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}), time.Hour)
	now := time.Now()
	require.NoError(t, s.Create(t.Context(), &Room{
		ID: "abc", Status: "ready", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
	chapters := []Chapter{{StartMs: 0, EndMs: 90_000, Title: "Abertura"}, {StartMs: 90_000, EndMs: 1_200_000}}

	require.NoError(t, s.SetChapters(t.Context(), "abc", chapters))
	got, err := s.Get(t.Context(), "abc")
	require.NoError(t, err)
	require.Equal(t, chapters, got.Chapters)

	_, _, err = s.SwapSource(t.Context(), "abc", SourceUpload, "other.mkv", "uploading", now)
	require.NoError(t, err)
	got, err = s.Get(t.Context(), "abc")
	require.NoError(t, err)
	require.Empty(t, got.Chapters)
}

func TestReclaimStaleClientClaims(t *testing.T) {
	mr := miniredis.RunT(t)
	s := NewStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}), time.Hour)
	now := time.Now()
	require.NoError(t, s.Create(t.Context(), &Room{
		ID: "stale", Status: "uploading", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
	require.NoError(t, s.Create(t.Context(), &Room{
		ID: "live", Status: "uploading", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
	require.NoError(t, s.ReserveUpload(t.Context(), "stale", "client:aaa", now))
	require.NoError(t, s.ReserveUpload(t.Context(), "live", "client:bbb", now))
	require.NoError(t, s.mutateRoom(t.Context(), "stale", false, "client_media_touched",
		strconv.FormatInt(now.Add(-10*time.Minute).UnixMilli(), 10)))
	require.NoError(t, s.TouchClientClaim(t.Context(), "live"))

	freed, err := s.ReclaimStaleClientClaims(t.Context(), 5*time.Minute)
	require.NoError(t, err)
	require.Equal(t, 1, freed)

	staleID, err := s.UploadID(t.Context(), "stale")
	require.NoError(t, err)
	require.Empty(t, staleID)
	liveID, err := s.UploadID(t.Context(), "live")
	require.NoError(t, err)
	require.Equal(t, "client:bbb", liveID)
}

func TestAddClientMediaBytesRefusesARoomWithoutAClaim(t *testing.T) {
	mr := miniredis.RunT(t)
	s := NewStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}), time.Hour)
	now := time.Now()
	require.NoError(t, s.Create(t.Context(), &Room{
		ID: "r1", Status: "uploading", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))

	_, err := s.AddClientMediaBytes(t.Context(), "r1", 100)
	require.ErrorIs(t, err, ErrNotFound)

	require.NoError(t, s.ReserveUpload(t.Context(), "r1", "client:aaa", now))
	total, err := s.AddClientMediaBytes(t.Context(), "r1", 100)
	require.NoError(t, err)
	require.Equal(t, int64(100), total)
}

func TestSetErrorPersistsStatusAndMessage(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	s := NewStore(rdb, time.Hour)
	now := time.Now()
	require.NoError(t, s.Create(t.Context(), &Room{
		ID: "broken", Status: "processing", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))

	require.NoError(t, s.SetError(t.Context(), "broken", "probe failed"))

	got, err := s.Get(t.Context(), "broken")
	require.NoError(t, err)
	require.Equal(t, "error", got.Status)
	require.Equal(t, "probe failed", got.ErrorMessage)
}

func TestRoomMutationsDoNotCreateMissingRoom(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(context.Context, *Store) error
	}{
		{name: "status", mutate: func(ctx context.Context, s *Store) error {
			return s.SetStatus(ctx, "missing", "processing")
		}},
		{name: "tracks", mutate: func(ctx context.Context, s *Store) error {
			return s.SetTracks(ctx, "missing", []TrackInfo{{Index: 0}}, nil, 0)
		}},
		{name: "error", mutate: func(ctx context.Context, s *Store) error {
			return s.SetError(ctx, "missing", "media processing failed")
		}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mr := miniredis.RunT(t)
			rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
			s := NewStore(rdb, time.Hour)

			err := tt.mutate(t.Context(), s)

			require.ErrorIs(t, err, ErrNotFound)
			require.False(t, mr.Exists("room:missing"))
		})
	}
}

func TestSetStatusRejectsExpiredRoom(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	s := NewStore(rdb, time.Hour)
	now := time.Now()
	require.NoError(t, s.Create(t.Context(), &Room{
		ID: "expired", Status: "uploading", CreatedAt: now.Add(-2 * time.Hour), ExpiresAt: now.Add(-time.Minute),
	}))

	err := s.SetStatus(t.Context(), "expired", "processing")

	require.ErrorIs(t, err, ErrNotFound)
	require.Equal(t, "uploading", mr.HGet("room:expired", "status"))
}

func TestLegacyNanosecondExpiryFallback(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(context.Context, *Store) error
	}{
		{
			name: "room mutation",
			mutate: func(ctx context.Context, store *Store) error {
				return store.SetStatus(ctx, "legacy", "processing")
			},
		},
		{
			name: "upload reservation",
			mutate: func(ctx context.Context, store *Store) error {
				return store.ReserveUpload(ctx, "legacy", "upload-1", time.Now())
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mr := miniredis.RunT(t)
			rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
			store := NewStore(rdb, time.Hour)
			now := time.Now()
			require.NoError(t, store.Create(t.Context(), &Room{
				ID: "legacy", Status: "uploading", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
			}))
			require.NoError(t, rdb.HDel(t.Context(), roomKey("legacy"), "expires_at_unix_ms").Err())

			require.NoError(t, tt.mutate(t.Context(), store))
		})
	}
}

func TestRoomCreationPersistsLegacyExpiryIndex(t *testing.T) {
	tests := []struct {
		name   string
		create func(context.Context, *Store, *Room) error
	}{
		{
			name: "room only",
			create: func(ctx context.Context, s *Store, r *Room) error {
				return s.Create(ctx, r)
			},
		},
		{
			name: "room with controller",
			create: func(ctx context.Context, s *Store, r *Room) error {
				return s.CreateWithMember(ctx, r, Member{ID: "m1", Nickname: "giuli", JoinedAt: r.CreatedAt})
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mr := miniredis.RunT(t)
			rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
			s := NewStore(rdb, 5*time.Hour)
			ctx := context.Background()
			require.NoError(t, rdb.ZAdd(ctx, byExpiryKey, redis.Z{Score: 0, Member: "legacy"}).Err())
			require.NoError(t, rdb.Expire(ctx, byExpiryKey, time.Hour).Err())

			now := time.Now()
			r := &Room{ID: "abc", FileName: "movie.mkv", Status: "uploading",
				ControllerID: "m1", CreatedAt: now, ExpiresAt: now.Add(5 * time.Hour)}
			require.NoError(t, tt.create(ctx, s, r))

			ttl, err := rdb.TTL(ctx, byExpiryKey).Result()
			require.NoError(t, err)
			require.Equal(t, time.Duration(-1), ttl)
		})
	}
}

func TestChatCappedAt200(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	s := NewStore(rdb, 5*time.Hour)
	r := &Room{ID: "abc", FileName: "movie.mkv", Status: "ready",
		ControllerID: "m1", CreatedAt: time.Now(), ExpiresAt: time.Now().Add(5 * time.Hour)}
	require.NoError(t, s.Create(context.Background(), r))

	ctx := context.Background()
	for i := 1; i <= 210; i++ {
		require.NoError(t, s.AddMessage(ctx, "abc", ChatMessage{
			Author: "alice",
			Text:   fmt.Sprintf("message %d", i),
			At:     time.Now(),
		}))
	}

	msgs, err := s.Messages(ctx, "abc")
	require.NoError(t, err)
	require.Len(t, msgs, 200)
	require.Equal(t, "message 11", msgs[0].Text)
	require.Equal(t, "message 210", msgs[199].Text)
}

func TestSetClientSubtitlesAndHasClientSubs(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	s := NewStore(rdb, time.Hour)
	now := time.Now()
	require.NoError(t, s.Create(t.Context(), &Room{
		ID: "subs", Status: "uploading", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))

	has, err := s.HasClientSubs(t.Context(), "subs")
	require.NoError(t, err)
	require.False(t, has)

	subs := []TrackInfo{{Index: 0, Language: "eng", Title: "Signs", Codec: "webvtt"}}
	require.NoError(t, s.SetClientSubtitles(t.Context(), "subs", subs, true))

	has, err = s.HasClientSubs(t.Context(), "subs")
	require.NoError(t, err)
	require.True(t, has)
	got, err := s.Get(t.Context(), "subs")
	require.NoError(t, err)
	require.True(t, got.ClientSubs)
	require.Equal(t, subs, got.SubtitleTracks)

	require.NoError(t, s.SetAudioTracks(t.Context(), "subs", []TrackInfo{{Index: 0, Language: "eng", Codec: "aac"}}, 2))
	got, err = s.Get(t.Context(), "subs")
	require.NoError(t, err)
	require.Equal(t, subs, got.SubtitleTracks)
	require.Equal(t, "aac", got.AudioTracks[0].Codec)
	require.Equal(t, 2, got.BitmapSubsSkipped)
}

func TestVersionsAdvanceWithRepublishedMedia(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	s := NewStore(rdb, time.Hour)
	now := time.Now()
	require.NoError(t, s.Create(t.Context(), &Room{
		ID: "v", Status: "processing", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
	got, err := s.Get(t.Context(), "v")
	require.NoError(t, err)
	require.Equal(t, 0, got.MediaVersion)
	require.Equal(t, 0, got.SubsVersion)

	require.NoError(t, s.BumpMediaVersion(t.Context(), "v"))
	require.NoError(t, s.BumpMediaVersion(t.Context(), "v"))
	got, err = s.Get(t.Context(), "v")
	require.NoError(t, err)
	require.Equal(t, 2, got.MediaVersion)

	require.NoError(t, s.SetClientSubtitles(t.Context(), "v", []TrackInfo{{Index: 0}}, false))
	require.NoError(t, s.SetClientSubtitles(t.Context(), "v", []TrackInfo{{Index: 0}}, true))
	require.NoError(t, s.SetTracks(t.Context(), "v", nil, []TrackInfo{{Index: 0}}, 0))
	got, err = s.Get(t.Context(), "v")
	require.NoError(t, err)
	require.Equal(t, 3, got.SubsVersion)
}

func TestBumpMediaVersionRejectsMissingRoom(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	s := NewStore(rdb, time.Hour)
	require.ErrorIs(t, s.BumpMediaVersion(t.Context(), "missing"), ErrNotFound)
}

func TestSetClientSubtitlesRejectsMissingRoom(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	s := NewStore(rdb, time.Hour)

	err := s.SetClientSubtitles(t.Context(), "missing", []TrackInfo{{Index: 0, Codec: "webvtt"}}, true)
	require.ErrorIs(t, err, ErrNotFound)

	has, err := s.HasClientSubs(t.Context(), "missing")
	require.NoError(t, err)
	require.False(t, has)
}

func TestGatingSettingDefaultsOnAndRoundTrips(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	s := NewStore(rdb, time.Hour)
	now := time.Now()
	require.NoError(t, s.Create(t.Context(), &Room{
		ID: "gated", Status: "ready", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))

	got, err := s.Get(t.Context(), "gated")
	require.NoError(t, err)
	require.True(t, got.GatingEnabled)

	require.NoError(t, s.SetGatingDisabled(t.Context(), "gated", true))
	got, err = s.Get(t.Context(), "gated")
	require.NoError(t, err)
	require.False(t, got.GatingEnabled)

	require.NoError(t, s.SetGatingDisabled(t.Context(), "gated", false))
	got, err = s.Get(t.Context(), "gated")
	require.NoError(t, err)
	require.True(t, got.GatingEnabled)
}

func TestSwapSourceClearsThePublishedMediaOfTheOldSource(t *testing.T) {
	mr := miniredis.RunT(t)
	store := NewStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}), time.Hour)
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &Room{
		ID: "r1", Status: "ready", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
	require.NoError(t, store.SetPlaylists(t.Context(), "r1", map[string]string{"master.m3u8": "#EXTM3U\n"}))
	require.NoError(t, store.MarkPublished(t.Context(), "r1", "stream_1_000.m4s"))

	_, generation, err := store.SwapSource(t.Context(), "r1", "upload", "next.mkv", "uploading", now)
	require.NoError(t, err)
	require.Equal(t, 1, generation)

	_, err = store.Playlist(t.Context(), "r1", "master.m3u8")
	require.ErrorIs(t, err, ErrNotFound)
	published, err := store.Published(t.Context(), "r1")
	require.NoError(t, err)
	require.Empty(t, published)
}

func TestSwarmStatsRoundTripAndClearOnSwap(t *testing.T) {
	mr := miniredis.RunT(t)
	s := NewStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}), time.Hour)
	now := time.Now()
	require.NoError(t, s.Create(t.Context(), &Room{ID: "abc", Status: "uploading", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}))
	got, err := s.Get(t.Context(), "abc")
	require.NoError(t, err)
	require.Nil(t, got.Preparation.Swarm)
	require.NoError(t, s.SetSwarm(t.Context(), "abc", SwarmStats{Peers: 12, DownSpeed: 3_000_000, HaveBytes: 500, SelectedBytes: 1000}))
	got, err = s.Get(t.Context(), "abc")
	require.NoError(t, err)
	require.Equal(t, &SwarmStats{Peers: 12, DownSpeed: 3_000_000, HaveBytes: 500, SelectedBytes: 1000}, got.Preparation.Swarm)
	_, _, err = s.SwapSource(t.Context(), "abc", SourceUpload, "other.mkv", "uploading", now)
	require.NoError(t, err)
	got, err = s.Get(t.Context(), "abc")
	require.NoError(t, err)
	require.Nil(t, got.Preparation.Swarm, "the swarm described the old source")
}

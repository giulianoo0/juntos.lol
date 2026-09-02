package room

import (
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

func commitStore(t *testing.T) *Store {
	t.Helper()
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	return NewStore(client, time.Hour)
}

func addRoomWithClaim(t *testing.T, s *Store, id, claim string) {
	t.Helper()
	now := time.Now()
	require.NoError(t, s.Create(t.Context(), &Room{
		ID: id, FileName: "movie.mkv", Status: "uploading", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
	require.NoError(t, s.ReserveUpload(t.Context(), id, claim, now))
}

func TestCommitPublishAppliesAtomically(t *testing.T) {
	s := commitStore(t)
	addRoomWithClaim(t, s, "r1", "client:a")

	outcome, err := s.CommitPublish(t.Context(), "r1", PublishCommit{
		Claim: "client:a", Generation: 0, RunID: "run1", Seq: 1, Digest: "d1",
		Confirmed:   []string{"cinit_1.mp4", "cs_1_1.m4s"},
		Playlists:   map[string]string{"client_stream_1.m3u8": "body1"},
		ApplyOffset: true, OffsetMs: 0,
		DurationMs: 60_000,
	})
	require.NoError(t, err)
	require.False(t, outcome.Replayed)

	published, err := s.Published(t.Context(), "r1")
	require.NoError(t, err)
	require.Contains(t, published, "cs_1_1.m4s")
	body, err := s.Playlist(t.Context(), "r1", "client_stream_1.m3u8")
	require.NoError(t, err)
	require.Equal(t, "body1", body)
	got, err := s.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, int64(60_000), got.DurationMs)
}

func TestCommitPublishFencesStaleSeq(t *testing.T) {
	s := commitStore(t)
	addRoomWithClaim(t, s, "r1", "client:a")

	_, err := s.CommitPublish(t.Context(), "r1", PublishCommit{
		Claim: "client:a", RunID: "run1", Seq: 2, Digest: "d2",
		Playlists: map[string]string{"client_stream_1.m3u8": "eight seconds"},
	})
	require.NoError(t, err)

	_, err = s.CommitPublish(t.Context(), "r1", PublishCommit{
		Claim: "client:a", RunID: "run1", Seq: 1, Digest: "d1",
		Playlists: map[string]string{"client_stream_1.m3u8": "four seconds"},
	})
	require.ErrorIs(t, err, ErrCommitSeq)
	body, err := s.Playlist(t.Context(), "r1", "client_stream_1.m3u8")
	require.NoError(t, err)
	require.Equal(t, "eight seconds", body)
}

func TestCommitPublishReplaysSameSeqSameDigest(t *testing.T) {
	s := commitStore(t)
	addRoomWithClaim(t, s, "r1", "client:a")

	_, err := s.CommitPublish(t.Context(), "r1", PublishCommit{
		Claim: "client:a", RunID: "run1", Seq: 1, Digest: "d1",
		Playlists: map[string]string{"client_stream_1.m3u8": "v1"},
	})
	require.NoError(t, err)
	outcome, err := s.CommitPublish(t.Context(), "r1", PublishCommit{
		Claim: "client:a", RunID: "run1", Seq: 1, Digest: "d1",
		Playlists: map[string]string{"client_stream_1.m3u8": "v1"},
	})
	require.NoError(t, err)
	require.True(t, outcome.Replayed)

	_, err = s.CommitPublish(t.Context(), "r1", PublishCommit{
		Claim: "client:a", RunID: "run1", Seq: 1, Digest: "dX",
		Playlists: map[string]string{"client_stream_1.m3u8": "v2"},
	})
	require.ErrorIs(t, err, ErrCommitSeq)
}

func TestCommitPublishFencesForeignRun(t *testing.T) {
	s := commitStore(t)
	addRoomWithClaim(t, s, "r1", "client:a")

	_, err := s.CommitPublish(t.Context(), "r1", PublishCommit{
		Claim: "client:a", RunID: "run1", Seq: 1, Digest: "d1",
	})
	require.NoError(t, err)
	_, err = s.CommitPublish(t.Context(), "r1", PublishCommit{
		Claim: "client:a", RunID: "run2", Seq: 1, Digest: "d1",
	})
	require.ErrorIs(t, err, ErrCommitRun)
}

func TestCommitPublishRefusesAfterSourceSwap(t *testing.T) {
	s := commitStore(t)
	addRoomWithClaim(t, s, "r1", "client:a")

	_, _, err := s.SwapSource(t.Context(), "r1", SourceUpload, "other.mkv", "uploading", time.Now())
	require.NoError(t, err)

	_, err = s.CommitPublish(t.Context(), "r1", PublishCommit{
		Claim: "client:a", Generation: 0, RunID: "run1", Seq: 5, Digest: "d5",
		Playlists: map[string]string{"client_stream_1.m3u8": "old generation"},
	})
	require.ErrorIs(t, err, ErrCommitClaim)
	_, err = s.Playlist(t.Context(), "r1", "client_stream_1.m3u8")
	require.ErrorIs(t, err, ErrNotFound)
}

func TestCommitPublishRefusesWrongGeneration(t *testing.T) {
	s := commitStore(t)
	addRoomWithClaim(t, s, "r1", "client:a")
	_, err := s.CommitPublish(t.Context(), "r1", PublishCommit{
		Claim: "client:a", Generation: 3, RunID: "run1", Seq: 1, Digest: "d1",
	})
	require.ErrorIs(t, err, ErrCommitGeneration)
}

func TestSwapSourceClearsProducerFencing(t *testing.T) {
	s := commitStore(t)
	addRoomWithClaim(t, s, "r1", "client:a")
	_, err := s.CommitPublish(t.Context(), "r1", PublishCommit{
		Claim: "client:a", RunID: "run1", Seq: 9, Digest: "d9",
	})
	require.NoError(t, err)
	_, generation, err := s.SwapSource(t.Context(), "r1", SourceUpload, "other.mkv", "uploading", time.Now())
	require.NoError(t, err)
	require.Equal(t, 1, generation)
	require.NoError(t, s.ReserveUpload(t.Context(), "r1", "client:b", time.Now()))
	_, err = s.CommitPublish(t.Context(), "r1", PublishCommit{
		Claim: "client:b", Generation: 1, RunID: "run2", Seq: 1, Digest: "d1",
	})
	require.NoError(t, err)
}

func TestCompleteReceiptRoundTrip(t *testing.T) {
	s := commitStore(t)
	addRoomWithClaim(t, s, "r1", "client:a")
	got, err := s.CompleteReceiptFor(t.Context(), "r1", "client:a")
	require.NoError(t, err)
	require.Nil(t, got)
	require.NoError(t, s.StoreCompleteReceipt(t.Context(), "r1", "client:a", CompleteReceipt{Ready: true}, time.Minute))
	got, err = s.CompleteReceiptFor(t.Context(), "r1", "client:a")
	require.NoError(t, err)
	require.NotNil(t, got)
	require.True(t, got.Ready)
}

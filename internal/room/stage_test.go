package room

import (
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

func newStageStore(t *testing.T) (*Store, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	return NewStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}), time.Hour), mr
}

func TestSwapSourceKeepsTheScreensAndTheLive(t *testing.T) {
	s, _ := newStageStore(t)
	now := time.Now()
	require.NoError(t, s.Create(t.Context(), &Room{
		ID: "r1", Status: StatusEmpty, CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
	require.NoError(t, s.StartScreenShare(t.Context(), "r1", ScreenShare{MemberID: "m2", Nickname: "ana", Since: now}))
	live := &LiveInfo{VideoID: "abc", Title: "show", Producer: "fleet", Broadcast: "b", MemberID: "m1", Status: "ready"}
	require.NoError(t, s.SetLive(t.Context(), "r1", live))

	_, generation, err := s.SwapSource(t.Context(), "r1", "m3", "movie.mkv", "uploading", now)
	require.NoError(t, err)
	require.Equal(t, 1, generation)

	got, err := s.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, "uploading", got.Status)
	require.Equal(t, "m3", got.SourceMemberID, "whoever opens the media holds it")
	require.Len(t, got.Screens, 1)
	require.Equal(t, "m2", got.Screens[0].MemberID)
	require.Equal(t, live, got.Live)
}

func TestARoomStartsWithoutMedia(t *testing.T) {
	require.False(t, (&Room{Status: StatusEmpty}).HasMedia())
	require.False(t, (&Room{}).HasMedia())
	require.True(t, (&Room{Status: "uploading"}).HasMedia())
	require.True(t, (&Room{Status: "ready"}).HasMedia())
}

func TestNameAndSpotlightRoundTrip(t *testing.T) {
	s, _ := newStageStore(t)
	now := time.Now()
	require.NoError(t, s.Create(t.Context(), &Room{
		ID: "r1", Name: "Sexta do terror", Status: StatusEmpty, CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
	got, err := s.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, "Sexta do terror", got.Name)
	require.Nil(t, got.Spotlight)

	spotlight := &Spotlight{Kind: StageScreen, MemberID: "m2"}
	require.NoError(t, s.SetSpotlight(t.Context(), "r1", spotlight))
	got, err = s.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, spotlight, got.Spotlight)

	require.NoError(t, s.SetSpotlight(t.Context(), "r1", nil))
	got, err = s.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Nil(t, got.Spotlight)
}

func TestScreenSharesAreCappedWithoutAnOpenFlag(t *testing.T) {
	s, _ := newStageStore(t)
	now := time.Now()
	require.NoError(t, s.Create(t.Context(), &Room{ID: "r1", Status: StatusEmpty, CreatedAt: now, ExpiresAt: now.Add(time.Hour)}))
	for _, id := range []string{"m1", "m2", "m3", "m4"} {
		require.NoError(t, s.StartScreenShare(t.Context(), "r1", ScreenShare{MemberID: id, Since: now}))
	}
	require.ErrorIs(t, s.StartScreenShare(t.Context(), "r1", ScreenShare{MemberID: "m5", Since: now}), ErrTooManyScreens)
	require.NoError(t, s.StartScreenShare(t.Context(), "r1", ScreenShare{MemberID: "m4", Since: now}), "restarting your own screen is not one more")
}

// A room made before stages coexisted kept the live's progress in the room's
// own status; read back, that status belongs to the live and the media is empty.
func TestALegacyLiveRoomHandsItsStatusToTheLive(t *testing.T) {
	s, mr := newStageStore(t)
	now := time.Now()
	require.NoError(t, s.Create(t.Context(), &Room{ID: "r1", Status: "ready", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}))
	mr.HSet("room:r1", "source_kind", "live", "live", `{"videoId":"v","title":"t","producer":"fleet","broadcast":"b"}`)
	got, err := s.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, StatusEmpty, got.Status)
	require.Equal(t, "ready", got.Live.Status)

	require.NoError(t, s.Create(t.Context(), &Room{ID: "r2", Status: "ready", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}))
	mr.HSet("room:r2", "source_kind", "screen")
	got, err = s.Get(t.Context(), "r2")
	require.NoError(t, err)
	require.Equal(t, StatusEmpty, got.Status)
}

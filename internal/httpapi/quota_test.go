package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

func newQuota(t *testing.T, dispatch, jobs int, bytes int64) (*Quota, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })
	return NewQuota(rdb, dispatch, jobs, bytes), mr
}

func TestQuotaDispatchBudget(t *testing.T) {
	q, _ := newQuota(t, 2, 0, 0)
	for i := 0; i < 2; i++ {
		v, err := q.CheckDispatch(t.Context(), "s1")
		require.NoError(t, err)
		require.Equal(t, QuotaOK, v)
	}
	v, err := q.CheckDispatch(t.Context(), "s1")
	require.NoError(t, err)
	require.Equal(t, QuotaDispatchLimit, v)
	v, err = q.CheckDispatch(t.Context(), "s2")
	require.NoError(t, err)
	require.Equal(t, QuotaOK, v)
}

func TestQuotaConcurrentJobs(t *testing.T) {
	q, _ := newQuota(t, 0, 1, 0)
	ok, err := q.AcquireJob(t.Context(), "s1", "j1", time.Hour)
	require.NoError(t, err)
	require.True(t, ok)
	ok, err = q.AcquireJob(t.Context(), "s1", "j2", time.Hour)
	require.NoError(t, err)
	require.False(t, ok)
	v, err := q.CheckDispatch(t.Context(), "s1")
	require.NoError(t, err)
	require.Equal(t, QuotaConcurrentJobs, v)
	require.NoError(t, q.ReleaseJob(t.Context(), "s1", "j1"))
	v, err = q.CheckDispatch(t.Context(), "s1")
	require.NoError(t, err)
	require.Equal(t, QuotaOK, v)
}

func TestQuotaBytesPerDay(t *testing.T) {
	q, _ := newQuota(t, 0, 0, 100)
	require.NoError(t, q.AddBytes(t.Context(), "s1", 60))
	v, err := q.CheckDispatch(t.Context(), "s1")
	require.NoError(t, err)
	require.Equal(t, QuotaOK, v)
	require.NoError(t, q.AddBytes(t.Context(), "s1", 40))
	v, err = q.CheckDispatch(t.Context(), "s1")
	require.NoError(t, err)
	require.Equal(t, QuotaBytesLimit, v)
}

func TestQuotaDispatchMiddleware(t *testing.T) {
	q, _ := newQuota(t, 1, 0, 0)
	r := gin.New()
	r.POST("/t", func(c *gin.Context) { c.Set(sessionContextKey, "s1") }, q.Dispatch(), func(c *gin.Context) {
		c.Status(http.StatusAccepted)
	})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/t", nil))
	require.Equal(t, http.StatusAccepted, w.Code)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/t", nil))
	require.Equal(t, http.StatusTooManyRequests, w.Code)
	require.Contains(t, w.Body.String(), "dispatch_limit")

	r2 := gin.New()
	r2.POST("/t", q.Dispatch(), func(c *gin.Context) { c.Status(http.StatusAccepted) })
	w = httptest.NewRecorder()
	r2.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/t", nil))
	require.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestQuotaProbeBudget(t *testing.T) {
	q, mr := newQuota(t, 0, 0, 0)
	for i := 0; i < probeListPerHour; i++ {
		ok, err := q.CheckProbes(t.Context(), "s1")
		require.NoError(t, err)
		require.True(t, ok)
	}
	ok, err := q.CheckProbes(t.Context(), "s1")
	require.NoError(t, err)
	require.False(t, ok)
	ok, err = q.CheckProbes(t.Context(), "s2")
	require.NoError(t, err)
	require.True(t, ok)
	mr.FastForward(2 * time.Hour)
	ok, err = q.CheckProbes(t.Context(), "s1")
	require.NoError(t, err)
	require.True(t, ok, "next hour's key starts over")
}

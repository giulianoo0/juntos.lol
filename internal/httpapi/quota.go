package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
)

// Quota enforces three per-session torrent budgets, each on its own clock:
// dispatches per hour, jobs at once, and bytes per day.
type Quota struct {
	rdb             *redis.Client
	dispatchPerHour int
	concurrentJobs  int
	bytesPerDay     int64
	// pluginFetchPerHour caps the requests one session may send through the
	// plugin hop. A field rather than a constant so a test can lower it.
	pluginFetchPerHour int
}

// NewQuota returns a Quota; a zero limit disables that budget.
func NewQuota(rdb *redis.Client, dispatchPerHour, concurrentJobs int, bytesPerDay int64) *Quota {
	return &Quota{rdb: rdb, dispatchPerHour: dispatchPerHour, concurrentJobs: concurrentJobs, bytesPerDay: bytesPerDay,
		pluginFetchPerHour: pluginFetchPerHour}
}

func dispatchKey(sid string) string {
	return "quota:" + sid + ":dispatch:" + time.Now().UTC().Format("2006010215")
}
func jobsKey(sid string) string { return "quota:" + sid + ":jobs" }
func bytesKey(sid string) string {
	return "quota:" + sid + ":bytes:" + time.Now().UTC().Format("20060102")
}

// QuotaVerdict names which budget refused, or "" for none.
type QuotaVerdict string

const (
	QuotaOK             QuotaVerdict = ""
	QuotaDispatchLimit  QuotaVerdict = "dispatch_limit"
	QuotaConcurrentJobs QuotaVerdict = "concurrent_jobs"
	QuotaBytesLimit     QuotaVerdict = "bytes_limit"
)

// CheckDispatch spends one dispatch from the session's hourly budget and verifies
// the other two have room. The dispatch is counted even when another budget refuses.
func (q *Quota) CheckDispatch(ctx context.Context, sid string) (QuotaVerdict, error) {
	if q.dispatchPerHour > 0 {
		key := dispatchKey(sid)
		n, err := q.rdb.Incr(ctx, key).Result()
		if err != nil {
			return QuotaOK, err
		}
		if n == 1 {
			q.rdb.Expire(ctx, key, time.Hour)
		}
		if n > int64(q.dispatchPerHour) {
			return QuotaDispatchLimit, nil
		}
	}
	if q.concurrentJobs > 0 {
		n, err := q.rdb.SCard(ctx, jobsKey(sid)).Result()
		if err != nil {
			return QuotaOK, err
		}
		if n >= int64(q.concurrentJobs) {
			return QuotaConcurrentJobs, nil
		}
	}
	if q.bytesPerDay > 0 {
		n, err := q.rdb.Get(ctx, bytesKey(sid)).Int64()
		if err != nil && err != redis.Nil {
			return QuotaOK, err
		}
		if n >= q.bytesPerDay {
			return QuotaBytesLimit, nil
		}
	}
	return QuotaOK, nil
}

// probeListPerHour caps fleet listings per session-hour; each one mints a fresh
// probe ticket per worker.
const probeListPerHour = 60

func probesKey(sid string) string {
	return "quota:" + sid + ":probes:" + time.Now().UTC().Format("2006010215")
}

// CheckProbes spends one fleet listing from the session's hourly budget;
// false means the budget is gone.
func (q *Quota) CheckProbes(ctx context.Context, sid string) (bool, error) {
	key := probesKey(sid)
	n, err := q.rdb.Incr(ctx, key).Result()
	if err != nil {
		return true, err
	}
	if n == 1 {
		q.rdb.Expire(ctx, key, time.Hour)
	}
	return n <= probeListPerHour, nil
}

const pluginFetchPerHour = 600

func pluginFetchKey(sid string) string {
	return "quota:" + sid + ":pluginfetch:" + time.Now().UTC().Format("2006010215")
}

// CheckPluginFetch spends one hop request from the session's hourly budget;
// false means the budget is gone.
func (q *Quota) CheckPluginFetch(ctx context.Context, sid string) (bool, error) {
	key := pluginFetchKey(sid)
	n, err := q.rdb.Incr(ctx, key).Result()
	if err != nil {
		return true, err
	}
	if n == 1 {
		q.rdb.Expire(ctx, key, time.Hour)
	}
	return n <= int64(q.pluginFetchPerHour), nil
}

// PluginFetch is the plugin hop's middleware: 429 once the session spent its hour.
func (q *Quota) PluginFetch() gin.HandlerFunc {
	return func(c *gin.Context) {
		sid := SessionID(c)
		if sid == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "no_session"})
			return
		}
		ok, err := q.CheckPluginFetch(c.Request.Context(), sid)
		if err != nil {
			slog.ErrorContext(c.Request.Context(), "plugin fetch quota check", "error", err)
			c.AbortWithStatus(http.StatusInternalServerError)
			return
		}
		if !ok {
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": "quota_exceeded", "reason": "plugin_fetch_limit"})
			return
		}
		c.Next()
	}
}

// AcquireJob records a running job against the session, refusing when the concurrent
// budget is full. ttl bounds a job whose release never comes.
func (q *Quota) AcquireJob(ctx context.Context, sid, jobID string, ttl time.Duration) (bool, error) {
	key := jobsKey(sid)
	if err := q.rdb.SAdd(ctx, key, jobID).Err(); err != nil {
		return false, err
	}
	q.rdb.Expire(ctx, key, ttl)
	if q.concurrentJobs <= 0 {
		return true, nil
	}
	n, err := q.rdb.SCard(ctx, key).Result()
	if err != nil {
		return false, err
	}
	if n > int64(q.concurrentJobs) {
		q.rdb.SRem(ctx, key, jobID)
		return false, nil
	}
	return true, nil
}

func (q *Quota) ReleaseJob(ctx context.Context, sid, jobID string) error {
	return q.rdb.SRem(ctx, jobsKey(sid), jobID).Err()
}

func (q *Quota) AddBytes(ctx context.Context, sid string, n int64) error {
	if n <= 0 {
		return nil
	}
	key := bytesKey(sid)
	total, err := q.rdb.IncrBy(ctx, key, n).Result()
	if err != nil {
		return err
	}
	if total == n {
		q.rdb.Expire(ctx, key, 48*time.Hour)
	}
	return nil
}

// Dispatch is the middleware for job-starting routes: 429 with the budget's name.
func (q *Quota) Dispatch() gin.HandlerFunc {
	return func(c *gin.Context) {
		sid := SessionID(c)
		if sid == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "no_session"})
			return
		}
		verdict, err := q.CheckDispatch(c.Request.Context(), sid)
		if err != nil {
			slog.ErrorContext(c.Request.Context(), "quota check", "error", err)
			c.AbortWithStatus(http.StatusInternalServerError)
			return
		}
		if verdict != QuotaOK {
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": "quota_exceeded", "reason": string(verdict)})
			return
		}
		c.Next()
	}
}

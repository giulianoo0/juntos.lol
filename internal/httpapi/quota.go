package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
)

// What one session may ask of the worker fleet. Three budgets, each with a
// different clock: dispatches per hour (the magnet paste), jobs at once
// (workers' disk), and bytes per day (workers' uplink, counted from what
// the workers report having served — the browser never says).

// Quota enforces per-session torrent budgets.
type Quota struct {
	rdb             *redis.Client
	dispatchPerHour int
	concurrentJobs  int
	bytesPerDay     int64
}

// NewQuota returns a Quota; a zero limit disables that budget.
func NewQuota(rdb *redis.Client, dispatchPerHour, concurrentJobs int, bytesPerDay int64) *Quota {
	return &Quota{rdb: rdb, dispatchPerHour: dispatchPerHour, concurrentJobs: concurrentJobs, bytesPerDay: bytesPerDay}
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

// CheckDispatch spends one dispatch from the session's hourly budget and
// verifies the other two budgets have room. It counts the dispatch even
// when refusing on another budget, so hammering a refused endpoint is not
// free.
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

// probeListPerHour caps how many fleet listings (each minting a fresh probe
// ticket per worker) one session may pull. The page lists once per room it
// opens and caches the ranking; past this the probe endpoint is being
// farmed for free egress, not measuring anything.
const probeListPerHour = 60

func probesKey(sid string) string {
	return "quota:" + sid + ":probes:" + time.Now().UTC().Format("2006010215")
}

// CheckProbes spends one fleet listing from the session's hourly budget;
// false means the budget is gone. The probe bytes themselves are capped
// per ticket on the worker; this caps how often new tickets are minted.
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

// AcquireJob records a running job against the session, refusing when the
// concurrent budget is already full. ttl bounds a job whose release never
// comes (a worker that vanished with the job).
func (q *Quota) AcquireJob(ctx context.Context, sid, jobID string, ttl time.Duration) (bool, error) {
	key := jobsKey(sid)
	// SADD then check: two racing acquires may both land, but the set is
	// bounded by the dispatch budget anyway, and the placement step refuses
	// on the worker's side too. Simple beats a Lua script here.
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

// ReleaseJob forgets a job.
func (q *Quota) ReleaseJob(ctx context.Context, sid, jobID string) error {
	return q.rdb.SRem(ctx, jobsKey(sid), jobID).Err()
}

// AddBytes charges bytes a worker reported serving for this session's job.
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

// Dispatch is the middleware for the route that starts a job: it refuses
// with 429 and the budget's name when the session is over.
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

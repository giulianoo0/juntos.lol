// Package usage counts how the site is used without keeping who used it. A
// day's distinct visitors and room-goers live only as HyperLogLog sketches in
// Redis, which answer "how many" and nothing else; what lasts, in Postgres,
// is one number per metric per day.
package usage

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"maps"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

// Days turn at midnight in Brasília, which has kept no summer time since 2019.
var zone = time.FixedZone("BRT", -3*60*60)

// keyTTL keeps a day's sketches long enough to be flushed after it ends.
const keyTTL = 3 * 24 * time.Hour

const callTimeout = 2 * time.Second

// Metrics are one day's numbers by name.
type Metrics map[string]int64

// Counter tallies the day. A nil Counter counts nothing, so tests and tools
// that build the server without one need not care.
type Counter struct {
	rdb  *redis.Client
	pool *pgxpool.Pool
	now  func() time.Time
}

func New(rdb *redis.Client, pool *pgxpool.Pool) *Counter {
	return &Counter{rdb: rdb, pool: pool, now: time.Now}
}

// Today is the day c counts into, as Postgres and the report name it.
func (c *Counter) Today() string { return DayOf(c.now()) }

// DayOf names the day t falls on.
func DayOf(t time.Time) string { return t.In(zone).Format(time.DateOnly) }

func totalsKey(day string) string    { return "usage:" + day }
func distinctsKey(day string) string { return "usage:" + day + ":distinct" }
func sketchKey(day, metric string) string {
	return "usage:" + day + ":distinct:" + metric
}

// raiseScript keeps the larger of a hash field and a new value.
var raiseScript = redis.NewScript(`
local current = tonumber(redis.call('HGET', KEYS[1], ARGV[1]) or '0')
if tonumber(ARGV[2]) > current then redis.call('HSET', KEYS[1], ARGV[1], ARGV[2]) end
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 0`)

// Add adds to today's totals.
func (c *Counter) Add(metrics Metrics) {
	if c == nil || len(metrics) == 0 {
		return
	}
	day := c.Today()
	c.do(func(ctx context.Context, p redis.Pipeliner) {
		for metric, n := range metrics {
			p.HIncrBy(ctx, totalsKey(day), metric, n)
		}
		p.Expire(ctx, totalsKey(day), keyTTL)
	})
}

// Distinct counts value once today under metric. Only a hash of the day and
// the value reaches the sketch, and the sketch keeps no member it was given.
func (c *Counter) Distinct(metric, value string) {
	if c == nil || value == "" {
		return
	}
	day := c.Today()
	sum := sha256.Sum256([]byte(day + "\x00" + value))
	c.do(func(ctx context.Context, p redis.Pipeliner) {
		p.PFAdd(ctx, sketchKey(day, metric), hex.EncodeToString(sum[:16]))
		p.Expire(ctx, sketchKey(day, metric), keyTTL)
		p.SAdd(ctx, distinctsKey(day), metric)
		p.Expire(ctx, distinctsKey(day), keyTTL)
	})
}

// Max keeps the highest n today has seen under metric.
func (c *Counter) Max(metric string, n int64) {
	if c == nil || n <= 0 {
		return
	}
	day := c.Today()
	ctx, cancel := context.WithTimeout(context.Background(), callTimeout)
	defer cancel()
	if err := raiseScript.Run(ctx, c.rdb, []string{totalsKey(day)}, metric, n, int(keyTTL/time.Second)).Err(); err != nil {
		slog.Warn("usage count failed", "error", err)
	}
}

func (c *Counter) do(fill func(context.Context, redis.Pipeliner)) {
	ctx, cancel := context.WithTimeout(context.Background(), callTimeout)
	defer cancel()
	if _, err := c.rdb.Pipelined(ctx, func(p redis.Pipeliner) error {
		fill(ctx, p)
		return nil
	}); err != nil {
		slog.Warn("usage count failed", "error", err)
	}
}

// Read is the day as Redis holds it, distinct counts included.
func (c *Counter) Read(ctx context.Context, day string) (Metrics, error) {
	totals, err := c.rdb.HGetAll(ctx, totalsKey(day)).Result()
	if err != nil {
		return nil, err
	}
	names, err := c.rdb.SMembers(ctx, distinctsKey(day)).Result()
	if err != nil {
		return nil, err
	}
	metrics := make(Metrics, len(totals)+len(names))
	for metric, value := range totals {
		n, _ := strconv.ParseInt(value, 10, 64)
		metrics[metric] = n
	}
	for _, metric := range names {
		n, err := c.rdb.PFCount(ctx, sketchKey(day, metric)).Result()
		if err != nil {
			return nil, err
		}
		metrics[metric] = n
	}
	return metrics, nil
}

// Run samples, every minute, how many people are in rooms and, every hour,
// writes today and yesterday to Postgres and logs today so far, until ctx ends.
func (c *Counter) Run(ctx context.Context, seated func() int) {
	minute := time.NewTicker(time.Minute)
	defer minute.Stop()
	lastFlush := c.now()
	for {
		select {
		case <-ctx.Done():
			return
		case <-minute.C:
		}
		c.Max("peak_members", int64(seated()))
		if now := c.now(); now.Sub(lastFlush) >= time.Hour || DayOf(now) != DayOf(lastFlush) {
			c.Flush(ctx, DayOf(lastFlush) != DayOf(now))
			lastFlush = now
		}
	}
}

// Flush saves today and yesterday, so a day's last hour is never lost, and
// logs today; closed also logs yesterday as the day just finished.
func (c *Counter) Flush(ctx context.Context, closed bool) {
	now := c.now()
	yesterday := DayOf(now.AddDate(0, 0, -1))
	for _, day := range []string{yesterday, DayOf(now)} {
		metrics, err := c.Read(ctx, day)
		if err != nil {
			slog.Warn("usage read failed", "day", day, "error", err)
			continue
		}
		if err := c.save(ctx, day, metrics); err != nil {
			slog.Warn("usage save failed", "day", day, "error", err)
		}
		if day != yesterday {
			logDay("usage today", day, metrics)
		} else if closed {
			logDay("usage day", day, metrics)
		}
	}
}

func logDay(msg, day string, m Metrics) {
	avg := "0"
	if m["room_sessions"] > 0 {
		avg = strconv.FormatFloat(float64(m["room_seconds"])/float64(m["room_sessions"])/60, 'f', 1, 64)
	}
	slog.Info(msg, "day", day, "visitors", m["visitors"], "visits", m["visits"],
		"rooms_created", m["rooms_created"], "room_people", m["room_people"],
		"room_sessions", m["room_sessions"], "avg_room_minutes", avg, "peak_members", m["peak_members"],
		"torrents", m["torrents"], "torrent_gb", strconv.FormatFloat(float64(m["torrent_bytes"])/(1<<30), 'f', 2, 64))
}

// save never lowers a number: a Redis that restarted mid-day starts over,
// and the row keeps what it had already seen.
func (c *Counter) save(ctx context.Context, day string, metrics Metrics) error {
	if c.pool == nil || len(metrics) == 0 {
		return nil
	}
	days, names, values := make([]string, 0, len(metrics)), make([]string, 0, len(metrics)), make([]int64, 0, len(metrics))
	for metric, value := range metrics {
		days, names, values = append(days, day), append(names, metric), append(values, value)
	}
	_, err := c.pool.Exec(ctx, `
		INSERT INTO usage_metrics (day, metric, value)
		SELECT * FROM unnest($1::date[], $2::text[], $3::bigint[])
		ON CONFLICT (day, metric) DO UPDATE SET value = GREATEST(usage_metrics.value, EXCLUDED.value)`,
		days, names, values)
	return err
}

// History is every saved day from since on, oldest first, with today read
// live from Redis over whatever the last flush left.
func (c *Counter) History(ctx context.Context, since string) (map[string]Metrics, error) {
	days := make(map[string]Metrics)
	if c.pool != nil {
		rows, err := c.pool.Query(ctx, `SELECT to_char(day, 'YYYY-MM-DD'), metric, value FROM usage_metrics WHERE day >= $1::date`, since)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var day, metric string
			var value int64
			if err := rows.Scan(&day, &metric, &value); err != nil {
				return nil, err
			}
			if days[day] == nil {
				days[day] = make(Metrics)
			}
			days[day][metric] = value
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	today := c.Today()
	live, err := c.Read(ctx, today)
	if err != nil {
		return nil, err
	}
	merged := maps.Clone(days[today])
	if merged == nil {
		merged = make(Metrics)
	}
	for metric, value := range live {
		merged[metric] = max(merged[metric], value)
	}
	days[today] = merged
	return days, nil
}

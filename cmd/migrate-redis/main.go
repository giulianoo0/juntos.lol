// Command migrate-redis copies what used to live only in Redis into Postgres:
// accounts with their friends, requests, history, sign-ins and invites, and
// the enrolled workers. It keeps the ids, leaves Redis untouched and can run
// again safely: rows already there are skipped. It ends by printing how many
// of each it found in Redis and how many Postgres holds, and exits 1 when
// they differ.
//
//	REDIS_URL=redis://… DATABASE_URL=postgres://… go run ./cmd/migrate-redis
package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"regexp"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/giulianoo0/ss/internal/account"
	"github.com/giulianoo0/ss/internal/db"
)

// sessionTTL is what a sign-in kept without an expiry gets; the store gives
// every new one 30 days.
const sessionTTL = 30 * 24 * time.Hour

func main() {
	redisURL, databaseURL := os.Getenv("REDIS_URL"), os.Getenv("DATABASE_URL")
	if redisURL == "" || databaseURL == "" {
		log.Fatal("REDIS_URL and DATABASE_URL are required")
	}
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		log.Fatal(err)
	}
	rdb := redis.NewClient(opts)
	defer rdb.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	pool, err := db.Open(ctx, databaseURL)
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()

	counts, err := importAll(ctx, rdb, pool)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("%-10s %8s %8s\n", "", "redis", "postgres")
	same := true
	for _, c := range counts {
		mark := ""
		if c.Redis != c.Postgres {
			mark, same = "  <- difere", false
		}
		fmt.Printf("%-10s %8d %8d%s\n", c.Name, c.Redis, c.Postgres, mark)
	}
	if !same {
		os.Exit(1)
	}
}

// count is one kind of record: how many Redis had and how many Postgres
// holds after the import.
type count struct {
	Name     string
	Redis    int64
	Postgres int64
}

var (
	accountRe  = regexp.MustCompile(`^account:(\d+)$`)
	friendsRe  = regexp.MustCompile(`^account:(\d+):friends$`)
	requestsRe = regexp.MustCompile(`^account:(\d+):requests:(in|out)$`)
	historyRe  = regexp.MustCompile(`^account:(\d+):history$`)
	invitesRe  = regexp.MustCompile(`^account:(\d+):invites$`)
	sessionRe  = regexp.MustCompile(`^account:session:([0-9a-f]+)$`)
	workerRe   = regexp.MustCompile(`^worker:([^:]+)$`)
)

type keys struct {
	accounts, friends, requests, history, invites, sessions, workers []string
}

func scan(ctx context.Context, rdb *redis.Client) (keys, error) {
	var k keys
	for _, match := range []string{"account:*", "worker:*"} {
		iter := rdb.Scan(ctx, 0, match, 1000).Iterator()
		for iter.Next(ctx) {
			key := iter.Val()
			switch {
			case accountRe.MatchString(key):
				k.accounts = append(k.accounts, key)
			case friendsRe.MatchString(key):
				k.friends = append(k.friends, key)
			case requestsRe.MatchString(key):
				k.requests = append(k.requests, key)
			case historyRe.MatchString(key):
				k.history = append(k.history, key)
			case invitesRe.MatchString(key):
				k.invites = append(k.invites, key)
			case sessionRe.MatchString(key):
				k.sessions = append(k.sessions, key)
			case workerRe.MatchString(key):
				k.workers = append(k.workers, key)
			}
		}
		if err := iter.Err(); err != nil {
			return keys{}, err
		}
	}
	return k, nil
}

func idOf(re *regexp.Regexp, key string) int64 {
	id, _ := strconv.ParseInt(re.FindStringSubmatch(key)[1], 10, 64)
	return id
}

func importAll(ctx context.Context, rdb *redis.Client, pool *pgxpool.Pool) ([]count, error) {
	k, err := scan(ctx, rdb)
	if err != nil {
		return nil, err
	}
	steps := []struct {
		name  string
		table string
		run   func() (int64, error)
	}{
		{"contas", "SELECT count(*) FROM accounts", func() (int64, error) { return importAccounts(ctx, rdb, pool, k.accounts) }},
		{"amizades", "SELECT count(*) FROM friendships", func() (int64, error) { return importFriends(ctx, rdb, pool, k.friends) }},
		{"pedidos", "SELECT count(*) FROM friend_requests", func() (int64, error) { return importRequests(ctx, rdb, pool, k.requests) }},
		{"histórico", "SELECT count(*) FROM watches", func() (int64, error) { return importHistory(ctx, rdb, pool, k.history) }},
		{"sessões", "SELECT count(*) FROM account_sessions WHERE expires_at > now()", func() (int64, error) { return importSessions(ctx, rdb, pool, k.sessions) }},
		{"convites", "SELECT count(*) FROM room_invites WHERE expires_at > now()", func() (int64, error) { return importInvites(ctx, rdb, pool, k.invites) }},
		{"workers", "SELECT count(*) FROM workers", func() (int64, error) { return importWorkers(ctx, rdb, pool, k.workers) }},
	}
	counts := make([]count, 0, len(steps))
	for _, step := range steps {
		found, err := step.run()
		if err != nil {
			return nil, fmt.Errorf("%s: %w", step.name, err)
		}
		c := count{Name: step.name, Redis: found}
		if err := pool.QueryRow(ctx, step.table).Scan(&c.Postgres); err != nil {
			return nil, err
		}
		counts = append(counts, c)
	}
	return counts, nil
}

func importAccounts(ctx context.Context, rdb *redis.Client, pool *pgxpool.Pool, keys []string) (int64, error) {
	var found, maxID int64
	for _, key := range keys {
		f, err := rdb.HGetAll(ctx, key).Result()
		if err != nil {
			return 0, err
		}
		if f["discordId"] == "" {
			log.Printf("%s: sem discordId, ignorada", key)
			continue
		}
		found++
		id := idOf(accountRe, key)
		maxID = max(maxID, id)
		created, err := time.Parse(time.RFC3339, f["createdAt"])
		if err != nil {
			created = time.Now().UTC().Truncate(time.Second)
		}
		sessions, _ := strconv.ParseInt(f["sessions"], 10, 64)
		watched, _ := strconv.ParseInt(f["watchedSeconds"], 10, 64)
		visibility := f["visibility"]
		if visibility == "" {
			visibility = account.VisibilityPrivate
		}
		if _, err := pool.Exec(ctx, `INSERT INTO accounts (id, discord_id, nickname, avatar, visibility,
			discord_username, discord_global_name, discord_public, created_at, sessions, watched_seconds)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT DO NOTHING`,
			id, f["discordId"], f["nickname"], f["avatar"], visibility, f["discordUsername"], f["discordGlobalName"],
			f["discordVisibility"] == account.VisibilityPublic, created, sessions, watched); err != nil {
			return 0, fmt.Errorf("%s: %w", key, err)
		}
	}
	seq, err := rdb.Get(ctx, "account:seq").Int64()
	if err != nil && !errors.Is(err, redis.Nil) {
		return 0, err
	}
	var stored int64
	if err := pool.QueryRow(ctx, "SELECT COALESCE(max(id), 0) FROM accounts").Scan(&stored); err != nil {
		return 0, err
	}
	// The next account takes the number after the highest one ever handed
	// out, here or in Redis.
	if next := max(seq, maxID, stored); next > 0 {
		if _, err := pool.Exec(ctx, "SELECT setval(pg_get_serial_sequence('accounts', 'id'), $1)", next); err != nil {
			return 0, err
		}
	}
	return found, nil
}

func members(ctx context.Context, rdb *redis.Client, key string) ([]int64, error) {
	raw, err := rdb.SMembers(ctx, key).Result()
	if err != nil {
		return nil, err
	}
	ids := make([]int64, 0, len(raw))
	for _, m := range raw {
		if id, err := strconv.ParseInt(m, 10, 64); err == nil {
			ids = append(ids, id)
		}
	}
	return ids, nil
}

func importFriends(ctx context.Context, rdb *redis.Client, pool *pgxpool.Pool, keys []string) (int64, error) {
	pairs := map[[2]int64]bool{}
	for _, key := range keys {
		id := idOf(friendsRe, key)
		others, err := members(ctx, rdb, key)
		if err != nil {
			return 0, err
		}
		for _, other := range others {
			if other != id {
				pairs[[2]int64{min(id, other), max(id, other)}] = true
			}
		}
	}
	for p := range pairs {
		if _, err := pool.Exec(ctx, `INSERT INTO friendships (a, b) SELECT $1::bigint, $2::bigint
			WHERE EXISTS (SELECT 1 FROM accounts WHERE id = $1) AND EXISTS (SELECT 1 FROM accounts WHERE id = $2)
			ON CONFLICT DO NOTHING`, p[0], p[1]); err != nil {
			return 0, err
		}
	}
	return int64(len(pairs)), nil
}

func importRequests(ctx context.Context, rdb *redis.Client, pool *pgxpool.Pool, keys []string) (int64, error) {
	asks := map[[2]int64]bool{}
	for _, key := range keys {
		match := requestsRe.FindStringSubmatch(key)
		id, _ := strconv.ParseInt(match[1], 10, 64)
		others, err := members(ctx, rdb, key)
		if err != nil {
			return 0, err
		}
		for _, other := range others {
			if other == id {
				continue
			}
			if match[2] == "out" {
				asks[[2]int64{id, other}] = true
			} else {
				asks[[2]int64{other, id}] = true
			}
		}
	}
	for ask := range asks {
		if _, err := pool.Exec(ctx, `INSERT INTO friend_requests (from_id, to_id) SELECT $1::bigint, $2::bigint
			WHERE EXISTS (SELECT 1 FROM accounts WHERE id = $1) AND EXISTS (SELECT 1 FROM accounts WHERE id = $2)
			ON CONFLICT DO NOTHING`, ask[0], ask[1]); err != nil {
			return 0, err
		}
	}
	return int64(len(asks)), nil
}

// importHistory copies each account's history in one transaction, and only
// into an account with none yet: watches have no natural key to conflict on.
func importHistory(ctx context.Context, rdb *redis.Client, pool *pgxpool.Pool, keys []string) (int64, error) {
	var found int64
	for _, key := range keys {
		id := idOf(historyRe, key)
		raws, err := rdb.LRange(ctx, key, 0, -1).Result()
		if err != nil {
			return 0, err
		}
		watches := make([]account.Watch, 0, len(raws))
		for _, raw := range raws {
			var watch account.Watch
			if json.Unmarshal([]byte(raw), &watch) == nil {
				watches = append(watches, watch)
			}
		}
		found += int64(len(watches))
		err = pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
			var skip bool
			if err := tx.QueryRow(ctx, `SELECT NOT EXISTS (SELECT 1 FROM accounts WHERE id = $1)
				OR EXISTS (SELECT 1 FROM watches WHERE account_id = $1)`, id).Scan(&skip); err != nil || skip {
				return err
			}
			// Oldest first, so the serial ids keep the list's order.
			for i := len(watches) - 1; i >= 0; i-- {
				w := watches[i]
				with := w.With
				if with == nil {
					with = []int64{}
				}
				if _, err := tx.Exec(ctx, `INSERT INTO watches (account_id, room_id, title, kind, started_at, duration_sec, with_ids)
					VALUES ($1, $2, $3, $4, $5, $6, $7)`, id, w.RoomID, w.Title, w.Kind, w.StartedAt, w.DurationSec, with); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			return 0, fmt.Errorf("%s: %w", key, err)
		}
	}
	return found, nil
}

func importSessions(ctx context.Context, rdb *redis.Client, pool *pgxpool.Pool, keys []string) (int64, error) {
	var found int64
	for _, key := range keys {
		id, err := rdb.Get(ctx, key).Int64()
		if errors.Is(err, redis.Nil) {
			continue
		}
		if err != nil {
			return 0, err
		}
		ttl, err := rdb.PTTL(ctx, key).Result()
		if err != nil {
			return 0, err
		}
		if ttl < 0 {
			ttl = sessionTTL
		}
		found++
		token := sessionRe.FindStringSubmatch(key)[1]
		hash := sha256.Sum256([]byte(token))
		if _, err := pool.Exec(ctx, `INSERT INTO account_sessions (token_hash, account_id, expires_at)
			SELECT $1, $2::bigint, $3 WHERE EXISTS (SELECT 1 FROM accounts WHERE id = $2)
			ON CONFLICT DO NOTHING`, hash[:], id, time.Now().Add(ttl)); err != nil {
			return 0, err
		}
	}
	return found, nil
}

func importInvites(ctx context.Context, rdb *redis.Client, pool *pgxpool.Pool, keys []string) (int64, error) {
	var found int64
	now := time.Now()
	for _, key := range keys {
		to := idOf(invitesRe, key)
		raws, err := rdb.HGetAll(ctx, key).Result()
		if err != nil {
			return 0, err
		}
		for _, raw := range raws {
			var invite account.RoomInvite
			if json.Unmarshal([]byte(raw), &invite) != nil || now.Sub(invite.At) > account.InviteTTL {
				continue
			}
			found++
			if _, err := pool.Exec(ctx, `INSERT INTO room_invites (to_id, from_id, room_id, at, expires_at)
				SELECT $1::bigint, $2::bigint, $3, $4, $5
				WHERE EXISTS (SELECT 1 FROM accounts WHERE id = $1) AND EXISTS (SELECT 1 FROM accounts WHERE id = $2)
				ON CONFLICT DO NOTHING`, to, invite.From, invite.RoomID, invite.At, invite.At.Add(account.InviteTTL)); err != nil {
				return 0, err
			}
		}
	}
	return found, nil
}

func importWorkers(ctx context.Context, rdb *redis.Client, pool *pgxpool.Pool, keys []string) (int64, error) {
	var found int64
	for _, key := range keys {
		if kind, err := rdb.Type(ctx, key).Result(); err != nil {
			return 0, err
		} else if kind != "hash" {
			continue
		}
		f, err := rdb.HGetAll(ctx, key).Result()
		if err != nil {
			return 0, err
		}
		if f["pubkey"] == "" {
			continue
		}
		found++
		enrolled, err := time.Parse(time.RFC3339, f["enrolledAt"])
		if err != nil {
			enrolled = time.Now()
		}
		var notAfter *int64
		if v, err := strconv.ParseInt(f["certNotAfter"], 10, 64); err == nil {
			notAfter = &v
		}
		if _, err := pool.Exec(ctx, `INSERT INTO workers (id, pubkey, public_base, enrolled_at, cert_not_after)
			VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
			workerRe.FindStringSubmatch(key)[1], f["pubkey"], f["publicBase"], enrolled, notAfter); err != nil {
			return 0, err
		}
	}
	return found, nil
}

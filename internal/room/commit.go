package room

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// The publish commit: everything a client-media publish changes lands in one
// Lua script, verified against the room's liveness, the producer's claim, the
// media generation and, when the client sends them, the run and seq fences.

var (
	ErrCommitClaim      = errors.New("claim_mismatch")
	ErrCommitGeneration = errors.New("stale_generation")
	ErrCommitRun        = errors.New("stale_run")
	ErrCommitSeq        = errors.New("stale_seq")
)

// PublishCommit is everything one publish wants to change, plus the fences
// it must pass.
type PublishCommit struct {
	Claim      string
	Generation int
	RunID      string
	Seq        int64
	Digest     string

	Confirmed     []string
	Playlists     map[string]string
	Regions       []MediaRegion
	DurationMs    int64
	ApplyOffset   bool
	OffsetMs      int64
	ReceivedBytes *int64
	SourceBytes   *int64
	Heartbeat     bool
}

type PublishOutcome struct {
	VersionBumped bool
	Replayed      bool
}

// CommitPublish applies one publish atomically. It returns ErrNotFound for a
// dead room, ErrCommitClaim / ErrCommitGeneration / ErrCommitRun /
// ErrCommitSeq for a publish the room has moved on from.
func (s *Store) CommitPublish(ctx context.Context, id string, commit PublishCommit) (PublishOutcome, error) {
	if commit.Confirmed == nil {
		commit.Confirmed = []string{}
	}
	if commit.Playlists == nil {
		commit.Playlists = map[string]string{}
	}
	confirmed, err := json.Marshal(commit.Confirmed)
	if err != nil {
		return PublishOutcome{}, fmt.Errorf("marshal confirmed: %w", err)
	}
	playlists, err := json.Marshal(commit.Playlists)
	if err != nil {
		return PublishOutcome{}, fmt.Errorf("marshal playlists: %w", err)
	}
	regions := ""
	if commit.Regions != nil {
		raw, err := json.Marshal(commit.Regions)
		if err != nil {
			return PublishOutcome{}, fmt.Errorf("marshal regions: %w", err)
		}
		regions = string(raw)
	}
	received, source := "", ""
	if commit.ReceivedBytes != nil {
		received = strconv.FormatInt(*commit.ReceivedBytes, 10)
	}
	if commit.SourceBytes != nil {
		source = strconv.FormatInt(*commit.SourceBytes, 10)
	}
	applyOffset := "0"
	if commit.ApplyOffset {
		applyOffset = "1"
	}
	heartbeat := "0"
	if commit.Heartbeat {
		heartbeat = "1"
	}

	result, err := s.rdb.Eval(ctx, commitPublishScript,
		[]string{roomKey(id), playlistsKey(id), publishedKey(id)},
		strconv.FormatInt(time.Now().UnixMilli(), 10),
		commit.Claim,
		strconv.Itoa(commit.Generation),
		commit.RunID,
		strconv.FormatInt(commit.Seq, 10),
		commit.Digest,
		string(confirmed),
		string(playlists),
		regions,
		strconv.FormatInt(commit.DurationMs, 10),
		applyOffset,
		strconv.FormatInt(commit.OffsetMs, 10),
		received,
		source,
		heartbeat,
		strconv.FormatInt(int64(s.ttl/time.Second), 10),
	).Slice()
	if err != nil {
		return PublishOutcome{}, fmt.Errorf("commit publish: %w", err)
	}
	if len(result) < 1 {
		return PublishOutcome{}, fmt.Errorf("commit publish: empty reply")
	}
	code, _ := result[0].(string)
	switch code {
	case "ok", "replayed":
		bumped := false
		if len(result) > 1 {
			if flag, _ := result[1].(int64); flag == 1 {
				bumped = true
			}
		}
		return PublishOutcome{VersionBumped: bumped, Replayed: code == "replayed"}, nil
	case "gone":
		return PublishOutcome{}, ErrNotFound
	case "claim":
		return PublishOutcome{}, ErrCommitClaim
	case "generation":
		return PublishOutcome{}, ErrCommitGeneration
	case "run":
		return PublishOutcome{}, ErrCommitRun
	case "seq":
		return PublishOutcome{}, ErrCommitSeq
	default:
		return PublishOutcome{}, fmt.Errorf("commit publish: unexpected reply %q", code)
	}
}

const commitPublishScript = `
local expires = redis.call('HGET', KEYS[1], 'expires_at_unix_ms')
if not expires then
  local nanos = redis.call('HGET', KEYS[1], 'expires_at_unix_nano')
  if nanos and string.len(nanos) > 6 then
    expires = string.sub(nanos, 1, string.len(nanos) - 6)
  end
end
if not expires or tonumber(expires) <= tonumber(ARGV[1]) then return {'gone'} end
if (redis.call('HGET', KEYS[1], 'upload_id') or '') ~= ARGV[2] then return {'claim'} end
if (redis.call('HGET', KEYS[1], 'media_generation') or '0') ~= ARGV[3] then return {'generation'} end
if ARGV[4] ~= '' then
  local run = redis.call('HGET', KEYS[1], 'producer_run')
  if not run then
    redis.call('HSET', KEYS[1], 'producer_run', ARGV[4])
  elseif run ~= ARGV[4] then
    return {'run'}
  end
  local last = tonumber(redis.call('HGET', KEYS[1], 'producer_seq') or '-1')
  local seq = tonumber(ARGV[5])
  if seq == last and ARGV[6] ~= '' and redis.call('HGET', KEYS[1], 'producer_digest') == ARGV[6] then
    return {'replayed', 0}
  end
  if seq <= last then return {'seq'} end
  redis.call('HSET', KEYS[1], 'producer_seq', ARGV[5], 'producer_digest', ARGV[6])
end
local confirmed = cjson.decode(ARGV[7])
for i = 1, #confirmed do
  redis.call('SADD', KEYS[3], confirmed[i])
end
local playlists = cjson.decode(ARGV[8])
for name, body in pairs(playlists) do
  redis.call('HSET', KEYS[2], name, body)
end
if ARGV[9] ~= '' then
  redis.call('HSET', KEYS[1], 'media_regions', ARGV[9])
end
if tonumber(ARGV[10]) > 0 and redis.call('HGET', KEYS[1], 'duration_ms') ~= ARGV[10] then
  redis.call('HSET', KEYS[1], 'duration_ms', ARGV[10])
end
local bumped = 0
if ARGV[11] == '1' then
  if redis.call('HGET', KEYS[1], 'media_offset_ms') ~= ARGV[12] then
    redis.call('HSET', KEYS[1], 'media_offset_ms', ARGV[12])
    redis.call('HINCRBY', KEYS[1], 'media_version', 1)
    bumped = 1
  end
end
if ARGV[13] ~= '' then redis.call('HSET', KEYS[1], 'received_bytes', ARGV[13]) end
if ARGV[14] ~= '' then redis.call('HSET', KEYS[1], 'source_bytes', ARGV[14]) end
if ARGV[15] == '1' then redis.call('HSET', KEYS[1], 'client_media_touched', ARGV[1]) end
redis.call('PEXPIREAT', KEYS[1], tonumber(expires))
local ttl = tonumber(ARGV[16])
if redis.call('EXISTS', KEYS[2]) == 1 then redis.call('EXPIRE', KEYS[2], ttl) end
if redis.call('EXISTS', KEYS[3]) == 1 then redis.call('EXPIRE', KEYS[3], ttl) end
return {'ok', bumped}
`

// CompleteReceipt remembers that a run's complete was accepted, so a retry
// that lost the response is answered the same way instead of hitting a
// released claim and reading as a source swap.
type CompleteReceipt struct {
	Ready bool `json:"ready"`
}

func completeReceiptKey(id, claim string) string { return "room:" + id + ":complete:" + claim }

func (s *Store) StoreCompleteReceipt(ctx context.Context, id, claim string, receipt CompleteReceipt, ttl time.Duration) error {
	raw, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	return s.rdb.Set(ctx, completeReceiptKey(id, claim), raw, ttl).Err()
}

func (s *Store) CompleteReceiptFor(ctx context.Context, id, claim string) (*CompleteReceipt, error) {
	raw, err := s.rdb.Get(ctx, completeReceiptKey(id, claim)).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var receipt CompleteReceipt
	if err := json.Unmarshal(raw, &receipt); err != nil {
		return nil, err
	}
	return &receipt, nil
}

// SetProducerRun designates which run the publish fence accepts, resetting
// its sequence. The orchestrator moves it before the old process is told to
// stop, so the old committer's next publish is refused first.
func (s *Store) SetProducerRun(ctx context.Context, id, runID string) error {
	_, err := s.rdb.Eval(ctx, `
redis.call('HSET', KEYS[1], 'producer_run', ARGV[1])
redis.call('HDEL', KEYS[1], 'producer_seq', 'producer_digest')
return 1
`, []string{roomKey(id)}, runID).Result()
	if err != nil {
		return fmt.Errorf("set producer run: %w", err)
	}
	return nil
}

// MetadataToken mints and stores the metadata capability for the room's
// current producer: chapters and track annotations may keep arriving for a
// while after the media completes, but never across a source swap.
func (s *Store) SetMetadataToken(ctx context.Context, id, token string) error {
	return s.mutateRoom(ctx, id, false, "metadata_token", token)
}

func (s *Store) MetadataTokenMatches(ctx context.Context, id, token string) (bool, error) {
	if token == "" {
		return false, nil
	}
	held, err := s.rdb.HGet(ctx, roomKey(id), "metadata_token").Result()
	if errors.Is(err, redis.Nil) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return held != "" && held == token, nil
}

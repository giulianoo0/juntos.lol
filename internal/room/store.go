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

// ErrNotFound is returned when a room does not exist (or has expired).
var ErrNotFound = errors.New("room not found")

// ErrUploadReserved indicates that a room already has an active tus upload.
var ErrUploadReserved = errors.New("upload already reserved")

// ErrUploadNotAllowed indicates that a room is missing, expired, or not uploading.
var ErrUploadNotAllowed = errors.New("upload not allowed")

// chatCap is the maximum number of chat messages kept per room.
const chatCap = 200

// Store persists rooms in Redis. Every key carries the room TTL.
type Store struct {
	rdb *redis.Client
	ttl time.Duration
}

// NewStore returns a Store writing to rdb with the given room TTL.
func NewStore(rdb *redis.Client, ttl time.Duration) *Store {
	return &Store{rdb: rdb, ttl: ttl}
}

func roomKey(id string) string    { return "room:" + id }
func stateKey(id string) string   { return "room:" + id + ":state" }
func chatKey(id string) string    { return "room:" + id + ":chat" }
func membersKey(id string) string { return "room:" + id + ":members" }
func uploadKey(id string) string  { return "room:" + id + ":upload" }

const byExpiryKey = "rooms:by_expiry"

// Create stores a new room and indexes it by expiry.
func (s *Store) Create(ctx context.Context, r *Room) error {
	audio, err := json.Marshal(r.AudioTracks)
	if err != nil {
		return fmt.Errorf("marshal audio tracks: %w", err)
	}
	subs, err := json.Marshal(r.SubtitleTracks)
	if err != nil {
		return fmt.Errorf("marshal subtitle tracks: %w", err)
	}

	key := roomKey(r.ID)
	_, err = s.rdb.TxPipelined(ctx, func(p redis.Pipeliner) error {
		p.HSet(ctx, key,
			"file_name", r.FileName,
			"status", r.Status,
			"source_kind", r.SourceKind,
			"media_generation", r.MediaGeneration,
			"controller_id", r.ControllerID,
			"audio_tracks", audio,
			"subtitle_tracks", subs,
			"bitmap_subs_skipped", r.BitmapSubsSkipped,
			"created_at", r.CreatedAt.Format(time.RFC3339Nano),
			"expires_at", r.ExpiresAt.Format(time.RFC3339Nano),
			"expires_at_unix_ms", r.ExpiresAt.UnixMilli(),
			"expires_at_unix_nano", r.ExpiresAt.UnixNano(),
		)
		p.Expire(ctx, key, s.ttl)
		p.ZAdd(ctx, byExpiryKey, redis.Z{Score: float64(r.ExpiresAt.Unix()), Member: r.ID})
		p.Persist(ctx, byExpiryKey)
		return nil
	})
	return err
}

// CreateWithMember stores a newly created room and its controller in one Redis
// transaction so callers never expose a room without its controller member.
func (s *Store) CreateWithMember(ctx context.Context, r *Room, m Member) error {
	audio, err := json.Marshal(r.AudioTracks)
	if err != nil {
		return fmt.Errorf("marshal audio tracks: %w", err)
	}
	subs, err := json.Marshal(r.SubtitleTracks)
	if err != nil {
		return fmt.Errorf("marshal subtitle tracks: %w", err)
	}
	member, err := json.Marshal(m)
	if err != nil {
		return fmt.Errorf("marshal member: %w", err)
	}

	key := roomKey(r.ID)
	_, err = s.rdb.TxPipelined(ctx, func(p redis.Pipeliner) error {
		p.HSet(ctx, key,
			"file_name", r.FileName,
			"status", r.Status,
			"source_kind", r.SourceKind,
			"media_generation", r.MediaGeneration,
			"controller_id", r.ControllerID,
			"audio_tracks", audio,
			"subtitle_tracks", subs,
			"bitmap_subs_skipped", r.BitmapSubsSkipped,
			"created_at", r.CreatedAt.Format(time.RFC3339Nano),
			"expires_at", r.ExpiresAt.Format(time.RFC3339Nano),
			"expires_at_unix_ms", r.ExpiresAt.UnixMilli(),
			"expires_at_unix_nano", r.ExpiresAt.UnixNano(),
		)
		p.Expire(ctx, key, s.ttl)
		p.HSet(ctx, membersKey(r.ID), m.ID, member)
		p.Expire(ctx, membersKey(r.ID), s.ttl)
		p.ZAdd(ctx, byExpiryKey, redis.Z{Score: float64(r.ExpiresAt.Unix()), Member: r.ID})
		p.Persist(ctx, byExpiryKey)
		return nil
	})
	if err != nil {
		return fmt.Errorf("create room and controller: %w", err)
	}
	return nil
}

// ReserveUpload atomically reserves uploadID for an unexpired uploading room.
func (s *Store) ReserveUpload(ctx context.Context, roomID, uploadID string, now time.Time) error {
	result, err := s.rdb.Eval(ctx, `
local status = redis.call('HGET', KEYS[1], 'status')
if not status then return 0 end
if status ~= 'uploading' then return 2 end
local expires = redis.call('HGET', KEYS[1], 'expires_at_unix_ms')
if not expires then
  local nanos = redis.call('HGET', KEYS[1], 'expires_at_unix_nano')
  if nanos and string.len(nanos) > 6 then
    expires = string.sub(nanos, 1, string.len(nanos) - 6)
  end
end
if not expires or tonumber(expires) <= tonumber(ARGV[2]) then return 3 end
if redis.call('HGET', KEYS[1], 'upload_id') then return 4 end
redis.call('HSET', KEYS[1], 'upload_id', ARGV[1])
redis.call('SET', KEYS[2], ARGV[1])
return 1
`, []string{roomKey(roomID), uploadKey(roomID)}, uploadID, strconv.FormatInt(now.UnixMilli(), 10)).Int64()
	if err != nil {
		return fmt.Errorf("reserve upload: %w", err)
	}
	switch result {
	case 1:
		return nil
	case 4:
		return ErrUploadReserved
	default:
		return ErrUploadNotAllowed
	}
}

// UploadID returns the reserved tus upload ID for roomID, if present.
func (s *Store) UploadID(ctx context.Context, roomID string) (string, error) {
	id, err := s.rdb.Get(ctx, uploadKey(roomID)).Result()
	if errors.Is(err, redis.Nil) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("get reserved upload: %w", err)
	}
	return id, nil
}

// ReleaseUpload clears uploadID when the matching upload is terminated before
// completion, allowing the room to receive a replacement upload.
func (s *Store) ReleaseUpload(ctx context.Context, roomID, uploadID string) error {
	_, err := s.rdb.Eval(ctx, `
if redis.call('HGET', KEYS[1], 'upload_id') ~= ARGV[1] then return 0 end
redis.call('HDEL', KEYS[1], 'upload_id')
redis.call('DEL', KEYS[2])
return 1
`, []string{roomKey(roomID), uploadKey(roomID)}, uploadID).Result()
	if err != nil {
		return fmt.Errorf("release upload: %w", err)
	}
	return nil
}

// Get loads a room by id. Returns ErrNotFound if the room is missing.
func (s *Store) Get(ctx context.Context, id string) (*Room, error) {
	fields, err := s.rdb.HGetAll(ctx, roomKey(id)).Result()
	if err != nil {
		return nil, err
	}
	if len(fields) == 0 {
		return nil, ErrNotFound
	}

	r := &Room{ID: id}
	r.FileName = fields["file_name"]
	r.Status = fields["status"]
	r.ErrorMessage = fields["error_message"]
	r.ControllerID = fields["controller_id"]
	if v := fields["audio_tracks"]; v != "" {
		if err := json.Unmarshal([]byte(v), &r.AudioTracks); err != nil {
			return nil, fmt.Errorf("unmarshal audio tracks: %w", err)
		}
	}
	if v := fields["subtitle_tracks"]; v != "" {
		if err := json.Unmarshal([]byte(v), &r.SubtitleTracks); err != nil {
			return nil, fmt.Errorf("unmarshal subtitle tracks: %w", err)
		}
	}
	if v := fields["bitmap_subs_skipped"]; v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return nil, fmt.Errorf("parse bitmap_subs_skipped: %w", err)
		}
		r.BitmapSubsSkipped = n
	}
	r.SourceKind = fields["source_kind"]
	if r.SourceKind == "" {
		r.SourceKind = SourceUpload
	}
	if v := fields["media_generation"]; v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return nil, fmt.Errorf("parse media_generation: %w", err)
		}
		r.MediaGeneration = n
	}
	if v := fields["media_version"]; v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return nil, fmt.Errorf("parse media_version: %w", err)
		}
		r.MediaVersion = n
	}
	if v := fields["subs_version"]; v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return nil, fmt.Errorf("parse subs_version: %w", err)
		}
		r.SubsVersion = n
	}
	r.ClientSubs = fields["client_subs"] == "1"
	if v := fields["created_at"]; v != "" {
		t, err := time.Parse(time.RFC3339Nano, v)
		if err != nil {
			return nil, fmt.Errorf("parse created_at: %w", err)
		}
		r.CreatedAt = t
	}
	if v := fields["expires_at"]; v != "" {
		t, err := time.Parse(time.RFC3339Nano, v)
		if err != nil {
			return nil, fmt.Errorf("parse expires_at: %w", err)
		}
		r.ExpiresAt = t
	}
	return r, nil
}

// SetStatus updates the room status.
func (s *Store) SetStatus(ctx context.Context, id, status string) error {
	return s.mutateRoom(ctx, id, status != "error", "status", status)
}

// SetController updates the room member currently allowed to control playback.
func (s *Store) SetController(ctx context.Context, id, controllerID string) error {
	return s.mutateRoom(ctx, id, false, "controller_id", controllerID)
}

// SetError marks a room as failed and stores a user-visible processing error.
func (s *Store) SetError(ctx context.Context, id, message string) error {
	return s.mutateRoom(ctx, id, false, "status", "error", "error_message", message)
}

// SetTracks stores the probed track lists and the bitmap-subtitle skip count.
func (s *Store) SetTracks(ctx context.Context, id string, audio, subs []TrackInfo, bitmapSkipped int) error {
	a, err := json.Marshal(audio)
	if err != nil {
		return fmt.Errorf("marshal audio tracks: %w", err)
	}
	b, err := json.Marshal(subs)
	if err != nil {
		return fmt.Errorf("marshal subtitle tracks: %w", err)
	}

	return s.mutateRoomBump(ctx, id, false, "subs_version",
		"audio_tracks", string(a),
		"subtitle_tracks", string(b),
		"bitmap_subs_skipped", bitmapSkipped,
	)
}

// BumpMediaVersion announces that the media behind the current generation was
// republished in place, telling players to reload the unchanged source URL.
func (s *Store) BumpMediaVersion(ctx context.Context, id string) error {
	return s.mutateRoomBump(ctx, id, false, "media_version")
}

// SetAudioTracks stores the probed audio tracks and bitmap-subtitle skip
// count without touching subtitle_tracks, preserving browser-supplied subs.
func (s *Store) SetAudioTracks(ctx context.Context, id string, audio []TrackInfo, bitmapSkipped int) error {
	a, err := json.Marshal(audio)
	if err != nil {
		return fmt.Errorf("marshal audio tracks: %w", err)
	}

	return s.mutateRoom(ctx, id, false,
		"audio_tracks", string(a),
		"bitmap_subs_skipped", bitmapSkipped,
	)
}

// SetClientSubtitles stores browser-extracted WebVTT subtitle tracks. Only a
// complete extraction marks the room so the media pipeline skips embedded
// subtitle extraction; a partial one is published for immediate playback while
// the authoritative ffmpeg pass stays scheduled.
func (s *Store) SetClientSubtitles(ctx context.Context, id string, subs []TrackInfo, complete bool) error {
	b, err := json.Marshal(subs)
	if err != nil {
		return fmt.Errorf("marshal subtitle tracks: %w", err)
	}

	fields := []any{"subtitle_tracks", string(b)}
	if complete {
		fields = append(fields, "client_subs", "1")
	}
	return s.mutateRoomBump(ctx, id, false, "subs_version", fields...)
}

// SwapSource repoints a live room at a new source without disturbing its
// members, chat or controller. Everything describing the previous media is
// cleared in one step: the tracks, the error, the browser-subtitle flag, the
// upload reservation and the playback position. It returns the upload id that
// was reserved before the swap, if any, so the caller can reclaim the bytes of
// an upload that is still in flight, plus the new media generation.
//
// A room that is gone or expired reports ErrNotFound rather than resurrecting.
func (s *Store) SwapSource(ctx context.Context, id, kind, fileName, status string, now time.Time) (previousUpload string, generation int, err error) {
	result, err := s.rdb.Eval(ctx, `
local status = redis.call('HGET', KEYS[1], 'status')
if not status then return {0, '', 0} end
local expires = redis.call('HGET', KEYS[1], 'expires_at_unix_ms')
if not expires then
  local nanos = redis.call('HGET', KEYS[1], 'expires_at_unix_nano')
  if nanos and string.len(nanos) > 6 then
    expires = string.sub(nanos, 1, string.len(nanos) - 6)
  end
end
if not expires or tonumber(expires) <= tonumber(ARGV[4]) then return {0, '', 0} end
local previous = redis.call('HGET', KEYS[1], 'upload_id') or ''
local generation = tonumber(redis.call('HGET', KEYS[1], 'media_generation') or '0') + 1
redis.call('HSET', KEYS[1],
  'status', ARGV[1],
  'file_name', ARGV[2],
  'source_kind', ARGV[3],
  'media_generation', generation,
  'media_version', 0,
  'subs_version', 0,
  'audio_tracks', 'null',
  'subtitle_tracks', 'null',
  'bitmap_subs_skipped', 0)
redis.call('HDEL', KEYS[1], 'upload_id', 'error_message', 'client_subs')
redis.call('DEL', KEYS[2])
redis.call('DEL', KEYS[3])
redis.call('PEXPIREAT', KEYS[1], tonumber(expires))
return {1, previous, generation}
`, []string{roomKey(id), uploadKey(id), stateKey(id)},
		status, fileName, kind, strconv.FormatInt(now.UnixMilli(), 10)).Slice()
	if err != nil {
		return "", 0, fmt.Errorf("swap room source: %w", err)
	}
	if len(result) != 3 {
		return "", 0, fmt.Errorf("swap room source: unexpected reply")
	}
	ok, _ := result[0].(int64)
	if ok != 1 {
		return "", 0, ErrNotFound
	}
	previousUpload, _ = result[1].(string)
	newGeneration, _ := result[2].(int64)
	return previousUpload, int(newGeneration), nil
}

// HasClientSubs reports whether the room received browser-extracted subs.
func (s *Store) HasClientSubs(ctx context.Context, id string) (bool, error) {
	v, err := s.rdb.HGet(ctx, roomKey(id), "client_subs").Result()
	if errors.Is(err, redis.Nil) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("get client subs flag: %w", err)
	}
	return v == "1", nil
}

func (s *Store) mutateRoom(ctx context.Context, id string, clearError bool, fields ...any) error {
	return s.mutateRoomBump(ctx, id, clearError, "", fields...)
}

// mutateRoomBump is mutateRoom plus an optional counter field incremented in
// the same atomic step, so a version can never advance without its payload.
func (s *Store) mutateRoomBump(ctx context.Context, id string, clearError bool, bumpField string, fields ...any) error {
	args := make([]any, 0, len(fields)+3)
	args = append(args, strconv.FormatInt(time.Now().UnixMilli(), 10))
	if clearError {
		args = append(args, "1")
	} else {
		args = append(args, "0")
	}
	args = append(args, bumpField)
	args = append(args, fields...)

	result, err := s.rdb.Eval(ctx, `
local expires = redis.call('HGET', KEYS[1], 'expires_at_unix_ms')
if not expires then
  local nanos = redis.call('HGET', KEYS[1], 'expires_at_unix_nano')
  if nanos and string.len(nanos) > 6 then
    expires = string.sub(nanos, 1, string.len(nanos) - 6)
  end
end
if not expires or tonumber(expires) <= tonumber(ARGV[1]) then return 0 end
for i = 4, #ARGV, 2 do
  redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1])
end
if ARGV[3] ~= '' then redis.call('HINCRBY', KEYS[1], ARGV[3], 1) end
if ARGV[2] == '1' then redis.call('HDEL', KEYS[1], 'error_message') end
redis.call('PEXPIREAT', KEYS[1], tonumber(expires))
return 1
`, []string{roomKey(id)}, args...).Int64()
	if err != nil {
		return fmt.Errorf("mutate room: %w", err)
	}
	if result == 0 {
		return ErrNotFound
	}
	return nil
}

// SetState stores the shared playback state.
func (s *Store) SetState(ctx context.Context, id string, st PlayState) error {
	key := stateKey(id)
	_, err := s.rdb.Pipelined(ctx, func(p redis.Pipeliner) error {
		p.HSet(ctx, key,
			"playing", st.Playing,
			"position_ms", st.PositionMs,
			"rate", st.Rate,
			"server_time_ms", st.ServerTimeMs,
		)
		p.Expire(ctx, key, s.ttl)
		return nil
	})
	return err
}

// GetState loads the playback state. A missing state returns the zero
// PlayState (paused at position 0).
func (s *Store) GetState(ctx context.Context, id string) (PlayState, error) {
	fields, err := s.rdb.HGetAll(ctx, stateKey(id)).Result()
	if err != nil {
		return PlayState{}, err
	}
	var st PlayState
	if v := fields["playing"]; v != "" {
		st.Playing, _ = strconv.ParseBool(v)
	}
	if v := fields["position_ms"]; v != "" {
		st.PositionMs, _ = strconv.ParseInt(v, 10, 64)
	}
	if v := fields["rate"]; v != "" {
		st.Rate, _ = strconv.ParseFloat(v, 64)
	}
	if v := fields["server_time_ms"]; v != "" {
		st.ServerTimeMs, _ = strconv.ParseInt(v, 10, 64)
	}
	return st, nil
}

// AddMember upserts a member in the room.
func (s *Store) AddMember(ctx context.Context, id string, m Member) error {
	data, err := json.Marshal(m)
	if err != nil {
		return fmt.Errorf("marshal member: %w", err)
	}
	key := membersKey(id)
	_, err = s.rdb.Pipelined(ctx, func(p redis.Pipeliner) error {
		p.HSet(ctx, key, m.ID, data)
		p.Expire(ctx, key, s.ttl)
		return nil
	})
	return err
}

// RemoveMember removes a member from the room.
func (s *Store) RemoveMember(ctx context.Context, id, memberID string) error {
	return s.rdb.HDel(ctx, membersKey(id), memberID).Err()
}

// Members returns all members of the room.
func (s *Store) Members(ctx context.Context, id string) ([]Member, error) {
	vals, err := s.rdb.HVals(ctx, membersKey(id)).Result()
	if err != nil {
		return nil, err
	}
	members := make([]Member, 0, len(vals))
	for _, v := range vals {
		var m Member
		if err := json.Unmarshal([]byte(v), &m); err != nil {
			return nil, fmt.Errorf("unmarshal member: %w", err)
		}
		members = append(members, m)
	}
	return members, nil
}

// AddMessage appends a chat message, keeping only the latest chatCap entries.
func (s *Store) AddMessage(ctx context.Context, id string, m ChatMessage) error {
	data, err := json.Marshal(m)
	if err != nil {
		return fmt.Errorf("marshal chat message: %w", err)
	}
	key := chatKey(id)
	_, err = s.rdb.Pipelined(ctx, func(p redis.Pipeliner) error {
		p.RPush(ctx, key, data)
		p.LTrim(ctx, key, -chatCap, -1)
		p.Expire(ctx, key, s.ttl)
		return nil
	})
	return err
}

// Messages returns the room chat, oldest first.
func (s *Store) Messages(ctx context.Context, id string) ([]ChatMessage, error) {
	vals, err := s.rdb.LRange(ctx, chatKey(id), 0, -1).Result()
	if err != nil {
		return nil, err
	}
	msgs := make([]ChatMessage, 0, len(vals))
	for _, v := range vals {
		var m ChatMessage
		if err := json.Unmarshal([]byte(v), &m); err != nil {
			return nil, fmt.Errorf("unmarshal chat message: %w", err)
		}
		msgs = append(msgs, m)
	}
	return msgs, nil
}

// Delete removes the room, its state, chat, members and expiry index entry.
func (s *Store) Delete(ctx context.Context, id string) error {
	_, err := s.rdb.Pipelined(ctx, func(p redis.Pipeliner) error {
		p.Del(ctx, roomKey(id), stateKey(id), chatKey(id), membersKey(id), uploadKey(id))
		p.ZRem(ctx, byExpiryKey, id)
		return nil
	})
	return err
}

// ExpiredIDs returns the ids of rooms whose ExpiresAt is at or before now.
func (s *Store) ExpiredIDs(ctx context.Context, now time.Time) ([]string, error) {
	return s.rdb.ZRangeByScore(ctx, byExpiryKey, &redis.ZRangeBy{
		Min: "-inf",
		Max: strconv.FormatInt(now.Unix(), 10),
	}).Result()
}

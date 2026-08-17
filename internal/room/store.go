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
	_, err = s.rdb.Pipelined(ctx, func(p redis.Pipeliner) error {
		p.HSet(ctx, key,
			"file_name", r.FileName,
			"status", r.Status,
			"controller_id", r.ControllerID,
			"audio_tracks", audio,
			"subtitle_tracks", subs,
			"bitmap_subs_skipped", r.BitmapSubsSkipped,
			"created_at", r.CreatedAt.Format(time.RFC3339Nano),
			"expires_at", r.ExpiresAt.Format(time.RFC3339Nano),
		)
		p.Expire(ctx, key, s.ttl)
		p.ZAdd(ctx, byExpiryKey, redis.Z{Score: float64(r.ExpiresAt.Unix()), Member: r.ID})
		p.Expire(ctx, byExpiryKey, s.ttl)
		return nil
	})
	return err
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
	key := roomKey(id)
	_, err := s.rdb.Pipelined(ctx, func(p redis.Pipeliner) error {
		p.HSet(ctx, key, "status", status)
		p.Expire(ctx, key, s.ttl)
		return nil
	})
	return err
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

	key := roomKey(id)
	_, err = s.rdb.Pipelined(ctx, func(p redis.Pipeliner) error {
		p.HSet(ctx, key,
			"audio_tracks", a,
			"subtitle_tracks", b,
			"bitmap_subs_skipped", bitmapSkipped,
		)
		p.Expire(ctx, key, s.ttl)
		return nil
	})
	return err
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
		p.Del(ctx, roomKey(id), stateKey(id), chatKey(id), membersKey(id))
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

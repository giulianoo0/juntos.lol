package room

import (
	"context"
	"errors"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

// Relay is the room's own MoQ relay and the two tokens it was born with. It
// lives in the room's hash, so it goes when the room goes.
type Relay struct {
	UID       string
	Publish   string
	Subscribe string
	Epoch     int
}

// RoomRelay returns the room's relay; a zero UID means it has none yet.
func (s *Store) RoomRelay(ctx context.Context, id string) (Relay, error) {
	values, err := s.rdb.HMGet(ctx, roomKey(id), "status", "moq_relay_uid", "moq_publish", "moq_subscribe", "moq_epoch").Result()
	if err != nil {
		return Relay{}, fmt.Errorf("get room relay: %w", err)
	}
	if values[0] == nil {
		return Relay{}, ErrNotFound
	}
	text := func(v any) string { t, _ := v.(string); return t }
	epoch, _ := strconv.Atoi(text(values[4]))
	return Relay{UID: text(values[1]), Publish: text(values[2]), Subscribe: text(values[3]), Epoch: epoch}, nil
}

// ErrRelayMoved is a swap that lost to another: the room is no longer on
// the relay the caller saw.
var ErrRelayMoved = errors.New("room relay moved")

// SwapRoomRelay moves the room from the relay `from` (empty: none yet) to
// `to` and returns the epoch: a room's first relay is epoch 0, and every
// move from one relay to another counts. Only the first of two concurrent
// swaps wins.
func (s *Store) SwapRoomRelay(ctx context.Context, id, from string, to Relay) (int, error) {
	result, err := s.rdb.Eval(ctx, `
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
if (redis.call('HGET', KEYS[1], 'moq_relay_uid') or '') ~= ARGV[1] then return -2 end
redis.call('HSET', KEYS[1], 'moq_relay_uid', ARGV[2], 'moq_publish', ARGV[3], 'moq_subscribe', ARGV[4])
if ARGV[1] == '' then return tonumber(redis.call('HGET', KEYS[1], 'moq_epoch') or '0') end
return redis.call('HINCRBY', KEYS[1], 'moq_epoch', 1)
`, []string{roomKey(id)}, from, to.UID, to.Publish, to.Subscribe).Int()
	if errors.Is(err, redis.Nil) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, fmt.Errorf("swap room relay: %w", err)
	}
	switch result {
	case -1:
		return 0, ErrNotFound
	case -2:
		return 0, ErrRelayMoved
	}
	return result, nil
}

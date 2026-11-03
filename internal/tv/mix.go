package tv

import (
	"context"
	"encoding/json"
	"errors"
	"math"

	"github.com/redis/go-redis/v9"
)

const (
	MaxMixPeople   = 64
	maxMixKeyBytes = 32
)

// Mix is how loud a TV plays the media and each person in the call. The
// owner's own voice at 0 is the clients' default; the server keeps what it is told.
type Mix struct {
	Media  float64            `json:"media"`
	People map[string]float64 `json:"people"`
}

func DefaultMix() Mix { return Mix{Media: 1, People: map[string]float64{}} }

func validVolume(v float64) bool { return v >= 0 && v <= 1 && !math.IsNaN(v) }

func (m Mix) Valid() bool {
	if !validVolume(m.Media) || len(m.People) > MaxMixPeople {
		return false
	}
	for id, volume := range m.People {
		if id == "" || len(id) > maxMixKeyBytes || !validVolume(volume) {
			return false
		}
	}
	return true
}

type Mixes struct {
	rdb *redis.Client
}

func NewMixes(rdb *redis.Client) *Mixes { return &Mixes{rdb: rdb} }

func mixKey(deviceID string) string { return "tv:mix:" + deviceID }

func (m *Mixes) Get(ctx context.Context, deviceID string) (Mix, error) {
	value, err := m.rdb.Get(ctx, mixKey(deviceID)).Bytes()
	if errors.Is(err, redis.Nil) {
		return DefaultMix(), nil
	}
	if err != nil {
		return Mix{}, err
	}
	var mix Mix
	if err := json.Unmarshal(value, &mix); err != nil {
		return DefaultMix(), nil
	}
	if mix.People == nil {
		mix.People = map[string]float64{}
	}
	return mix, nil
}

func (m *Mixes) Set(ctx context.Context, deviceID string, mix Mix) error {
	if mix.People == nil {
		mix.People = map[string]float64{}
	}
	value, err := json.Marshal(mix)
	if err != nil {
		return err
	}
	return m.rdb.Set(ctx, mixKey(deviceID), value, 0).Err()
}

func (m *Mixes) Drop(ctx context.Context, deviceID string) error {
	return m.rdb.Del(ctx, mixKey(deviceID)).Err()
}

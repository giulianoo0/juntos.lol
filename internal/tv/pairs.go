package tv

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"

	gonanoid "github.com/matoous/go-nanoid/v2"
	"github.com/redis/go-redis/v9"
)

const (
	PairTTL = 10 * time.Minute
	// The code is read off a TV across the room, so no two of its
	// characters look alike (no O and 0, no I, L and 1).
	codeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
	codeLength   = 8
)

var ErrPending = errors.New("tv pair not linked yet")

type Pair struct {
	ID        string
	Code      string
	ExpiresAt time.Time
}

type DeviceCard struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type AccountCard struct {
	ID       int64  `json:"id"`
	Nickname string `json:"nickname"`
	Avatar   string `json:"avatar"`
}

// Linked is what the TV that paired is handed, once.
type Linked struct {
	Token   string      `json:"token"`
	Device  DeviceCard  `json:"device"`
	Account AccountCard `json:"account"`
}

// Pairs is the rendezvous between a TV showing a code and the account that
// types it in. It lives in Redis and lapses on its own.
type Pairs struct {
	rdb *redis.Client
}

func NewPairs(rdb *redis.Client) *Pairs { return &Pairs{rdb: rdb} }

func pairKey(id string) string       { return "tv:pair:" + id }
func pairCodeKey(code string) string { return "tv:paircode:" + code }

// pending is what tv:pair holds until the code is typed in.
const pendingValue = `{"status":"pending"}`

func (p *Pairs) Start(ctx context.Context) (Pair, error) {
	raw := make([]byte, 18)
	if _, err := rand.Read(raw); err != nil {
		return Pair{}, err
	}
	id := base64.RawURLEncoding.EncodeToString(raw)
	for range 5 {
		code, err := gonanoid.Generate(codeAlphabet, codeLength)
		if err != nil {
			return Pair{}, err
		}
		taken, err := p.rdb.SetNX(ctx, pairCodeKey(code), id, PairTTL).Result()
		if err != nil {
			return Pair{}, err
		}
		if !taken {
			continue
		}
		if err := p.rdb.Set(ctx, pairKey(id), pendingValue, PairTTL).Err(); err != nil {
			return Pair{}, err
		}
		return Pair{ID: id, Code: code, ExpiresAt: time.Now().Add(PairTTL)}, nil
	}
	return Pair{}, errors.New("no free tv pair code")
}

// normalizeCode reads a code the way a person types it: any case, with or
// without the hyphen shown on the TV.
func normalizeCode(typed string) (string, bool) {
	code := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(typed), "-", ""))
	if len(code) != codeLength {
		return "", false
	}
	for _, c := range code {
		if !strings.ContainsRune(codeAlphabet, c) {
			return "", false
		}
	}
	return code, true
}

// Claim spends a code and says which pair it opens; a second claim of the
// same code finds nothing.
func (p *Pairs) Claim(ctx context.Context, typed string) (string, error) {
	code, ok := normalizeCode(typed)
	if !ok {
		return "", ErrNotFound
	}
	id, err := p.rdb.GetDel(ctx, pairCodeKey(code)).Result()
	if errors.Is(err, redis.Nil) {
		return "", ErrNotFound
	}
	return id, err
}

// Complete leaves the token for the TV to pick up, within what is left of
// the pair's time.
func (p *Pairs) Complete(ctx context.Context, id string, linked Linked) error {
	value, err := json.Marshal(struct {
		Status string `json:"status"`
		Linked
	}{Status: "linked", Linked: linked})
	if err != nil {
		return err
	}
	set, err := p.rdb.SetXX(ctx, pairKey(id), value, redis.KeepTTL).Result()
	if err != nil {
		return err
	}
	if !set {
		return ErrNotFound
	}
	return nil
}

// Poll is ErrPending until the pair is linked, then the link exactly once.
func (p *Pairs) Poll(ctx context.Context, id string) (Linked, error) {
	value, err := p.rdb.Get(ctx, pairKey(id)).Result()
	if errors.Is(err, redis.Nil) {
		return Linked{}, ErrNotFound
	}
	if err != nil {
		return Linked{}, err
	}
	if value == pendingValue {
		return Linked{}, ErrPending
	}
	// Taken again with GETDEL so two polls racing hand the token out once.
	value, err = p.rdb.GetDel(ctx, pairKey(id)).Result()
	if errors.Is(err, redis.Nil) {
		return Linked{}, ErrNotFound
	}
	if err != nil {
		return Linked{}, err
	}
	var linked Linked
	if err := json.Unmarshal([]byte(value), &linked); err != nil {
		return Linked{}, err
	}
	return linked, nil
}

package room

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/redis/go-redis/v9"
)

func bansKey(id string) string { return "room:" + id + ":bans" }

// Ban is someone the host put out of the room, kept until the host lets them
// back in or the room ends. The seat's capability, the browser and the address
// are stored hashed: the server only ever compares them.
type Ban struct {
	// ID is the member id the seat had, which is how the host names the ban.
	ID         string    `json:"id"`
	Nickname   string    `json:"nickname"`
	Avatar     string    `json:"avatar,omitempty"`
	Capability string    `json:"capability,omitempty"`
	Device     string    `json:"device,omitempty"`
	AccountID  int64     `json:"accountId,omitempty"`
	IP         string    `json:"ip,omitempty"`
	At         time.Time `json:"at"`
}

// Arrival is who is at the door, as the socket presents them, in the clear.
type Arrival struct {
	MemberID   string
	Capability string
	Device     string
	AccountID  int64
	IP         string
}

// BanHash is how a ban keeps a secret it only needs to recognise.
func BanHash(value string) string {
	if value == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func sameHash(stored, value string) bool {
	if stored == "" || value == "" {
		return false
	}
	hashed := BanHash(value)
	return subtle.ConstantTimeCompare([]byte(stored), []byte(hashed)) == 1
}

// Matches reports whether the arrival is the person banned: the same seat
// coming back, the same browser, the same account or the same address.
func (b Ban) Matches(a Arrival) bool {
	if a.MemberID != "" && a.MemberID == b.ID && sameHash(b.Capability, a.Capability) {
		return true
	}
	if b.AccountID != 0 && a.AccountID == b.AccountID {
		return true
	}
	return sameHash(b.Device, a.Device) || sameHash(b.IP, a.IP)
}

// AddBan keeps a ban for as long as the room can live.
func (s *Store) AddBan(ctx context.Context, id string, ban Ban) error {
	data, err := json.Marshal(ban)
	if err != nil {
		return fmt.Errorf("marshal ban: %w", err)
	}
	_, err = s.rdb.Pipelined(ctx, func(p redis.Pipeliner) error {
		p.HSet(ctx, bansKey(id), ban.ID, data)
		p.Expire(ctx, bansKey(id), s.ttl)
		return nil
	})
	if err != nil {
		return fmt.Errorf("add ban: %w", err)
	}
	return nil
}

// Bans lists the room's bans, oldest first.
func (s *Store) Bans(ctx context.Context, id string) ([]Ban, error) {
	values, err := s.rdb.HVals(ctx, bansKey(id)).Result()
	if err != nil {
		return nil, fmt.Errorf("load bans: %w", err)
	}
	bans := make([]Ban, 0, len(values))
	for _, value := range values {
		var ban Ban
		if err := json.Unmarshal([]byte(value), &ban); err != nil || ban.ID == "" {
			continue
		}
		bans = append(bans, ban)
	}
	sort.Slice(bans, func(i, j int) bool { return bans[i].At.Before(bans[j].At) })
	return bans, nil
}

// RemoveBan lets someone back in; false when there was no such ban.
func (s *Store) RemoveBan(ctx context.Context, id, banID string) (bool, error) {
	removed, err := s.rdb.HDel(ctx, bansKey(id), banID).Result()
	if err != nil {
		return false, fmt.Errorf("remove ban: %w", err)
	}
	return removed > 0, nil
}

package room

import (
	"context"
	"errors"
	"fmt"

	"github.com/redis/go-redis/v9"
)

// How a room lets people in: anyone with the link, anyone who knows the
// password, or whoever the host lets in from the lobby. The host always
// walks straight in with the owner token.
const (
	JoinOpen     = "open"
	JoinPassword = "password"
	JoinApproval = "approval"
)

func ValidJoinMode(mode string) bool {
	return mode == JoinOpen || mode == JoinPassword || mode == JoinApproval
}

// Access is how a room is entered. The hash never leaves the server.
type Access struct {
	Mode         string
	PasswordHash string
}

// SetAccess changes how the room is entered. A mode other than password
// drops any stored hash, so switching back asks for a new one.
func (s *Store) SetAccess(ctx context.Context, id string, access Access) error {
	hash := access.PasswordHash
	if access.Mode != JoinPassword {
		hash = ""
	}
	return s.mutateRoom(ctx, id, false, "join_mode", access.Mode, "password_hash", hash)
}

// Access reads how the room is entered; a room that never set it is open.
func (s *Store) Access(ctx context.Context, id string) (Access, error) {
	fields, err := s.rdb.HMGet(ctx, roomKey(id), "status", "join_mode", "password_hash").Result()
	if errors.Is(err, redis.Nil) {
		return Access{}, ErrNotFound
	}
	if err != nil {
		return Access{}, fmt.Errorf("get room access: %w", err)
	}
	if fields[0] == nil {
		return Access{}, ErrNotFound
	}
	access := Access{Mode: JoinOpen}
	if mode, _ := fields[1].(string); ValidJoinMode(mode) {
		access.Mode = mode
	}
	access.PasswordHash, _ = fields[2].(string)
	return access, nil
}

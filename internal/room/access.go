package room

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"github.com/redis/go-redis/v9"
	"golang.org/x/crypto/argon2"
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

// argon2id at OWASP's floor (19 MiB, two passes): slow enough that a stolen
// hash is costly to guess, cheap enough for a few joins a minute.
const (
	argonTime    = 2
	argonMemory  = 19 * 1024
	argonThreads = 1
	argonKeyLen  = 32
	argonSaltLen = 16
)

// HashPassword returns the PHC string for a room password, salt included.
func HashPassword(password string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("salt password: %w", err)
	}
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version, argonMemory, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}

// VerifyPassword checks a password against a PHC string from HashPassword,
// using the parameters the string carries.
func VerifyPassword(password, encoded string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false
	}
	var memory, passes uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &passes, &threads); err != nil || threads == 0 || passes == 0 || memory > 256*1024 {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil || len(want) == 0 || len(want) > 64 {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, passes, memory, threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}

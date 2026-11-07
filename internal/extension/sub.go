package extension

import (
	"crypto/sha256"
	"encoding/base32"
	"strings"
)

// SubFor is the subdomain an extension is served from: stable for its id and
// the same formula the host Worker uses.
func SubFor(id string) string {
	sum := sha256.Sum256([]byte("juntos-ext:" + id))
	encoded := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(sum[:])
	return strings.ToLower(encoded[:16])
}

// ValidSub reports whether s could be a SubFor result at all.
func ValidSub(s string) bool {
	if len(s) != 16 {
		return false
	}
	for _, r := range s {
		if (r < 'a' || r > 'z') && (r < '2' || r > '7') {
			return false
		}
	}
	return true
}

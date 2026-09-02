// Package worker is the server's side of the remote torrent workers: who
// they are, what they hold, which one a job goes to, and the signature that
// makes a job theirs.
package worker

import (
	"bufio"
	"encoding/hex"
	"os"
	"strings"
)

// Blocklist is what the instance refuses to dispatch, applied at signing time
// so a refused infohash is never stored anywhere.
type Blocklist struct {
	hashes   map[string]struct{}
	keywords []string
}

// LoadBlocklist reads one entry per line: a 40-hex infohash, or a
// case-insensitive keyword matched against the torrent's name. Blank lines
// and `#` comments are skipped. An empty path is an empty list.
func LoadBlocklist(path string) (*Blocklist, error) {
	b := &Blocklist{hashes: map[string]struct{}{}}
	if path == "" {
		return b, nil
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if isInfohash(line) {
			b.hashes[strings.ToLower(line)] = struct{}{}
			continue
		}
		b.keywords = append(b.keywords, normalize(line))
	}
	return b, scanner.Err()
}

// normalize folds case and the separators release names use, so a keyword
// written with spaces matches a name written with dots.
func normalize(s string) string {
	return strings.ToLower(strings.NewReplacer(".", " ", "_", " ", "-", " ").Replace(s))
}

func isInfohash(s string) bool {
	if len(s) != 40 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}

// Rejects answers whether a torrent may not be dispatched. name may be empty
// when only the hash is known; the check runs again once metadata resolves.
func (b *Blocklist) Rejects(infohash, name string) bool {
	if b == nil {
		return false
	}
	if _, hit := b.hashes[strings.ToLower(infohash)]; hit {
		return true
	}
	if name == "" {
		return false
	}
	lower := normalize(name)
	for _, kw := range b.keywords {
		if strings.Contains(lower, kw) {
			return true
		}
	}
	return false
}

func (b *Blocklist) Len() int {
	if b == nil {
		return 0
	}
	return len(b.hashes) + len(b.keywords)
}

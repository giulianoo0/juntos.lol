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

// Blocklist is what the instance refuses to dispatch, applied at signing
// time so a refused infohash is never stored anywhere: not in a job, not
// in a worker's disk, not in a log line richer than "refused".
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
		b.keywords = append(b.keywords, strings.ToLower(line))
	}
	return b, scanner.Err()
}

func isInfohash(s string) bool {
	if len(s) != 40 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}

// Rejects answers whether a torrent may not be dispatched. name may be
// empty when only the hash is known yet; the check runs again once the
// worker resolved the metadata.
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
	lower := strings.ToLower(name)
	for _, kw := range b.keywords {
		if strings.Contains(lower, kw) {
			return true
		}
	}
	return false
}

// Len is how many entries the list carries.
func (b *Blocklist) Len() int {
	if b == nil {
		return 0
	}
	return len(b.hashes) + len(b.keywords)
}

// Package extension keeps the global registry of extensions: which id belongs
// to which source, and the subdomain each one is served from.
package extension

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"path"
	"regexp"
	"strings"
	"unicode/utf8"
)

// Manifest is the juntos.json at the root of an extension.
type Manifest struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Version  string `json:"version"`
	Protocol int    `json:"protocol"`
	Entry    string `json:"entry"`
	Icon     string `json:"icon,omitempty"`
	Hosts    Hosts  `json:"hosts"`
	Captcha  string `json:"captcha,omitempty"`
}

type Hosts struct {
	Connect []string `json:"connect"`
	Images  []string `json:"images"`
	Media   []string `json:"media"`
}

const (
	maxHostsPerList = 16
	maxNameLen      = 64
	maxVersionLen   = 64
	maxPathLen      = 256
	// AnyHost, as a list's only entry, lets the extension reach any https host.
	AnyHost = "*"
)

var (
	ErrBadManifest = errors.New("bad manifest")

	idPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{2,31}$`)
	// A path segment the extension host will serve (extensions/host/src/route.ts).
	segmentPattern = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9._@+-]{0,127}$`)
	// A DNS label: lowercase, no leading or trailing hyphen.
	labelPattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)
	// "host" is a path segment of /api/extensions/host/:sub.
	reservedIDs = map[string]bool{"host": true}
	// juntos itself and the extensions' own place are never an extension's host.
	reservedDomains = []string{"juntos.lol", "santamagia.com"}
	manifestKeys    = []string{"id", "name", "version", "protocol", "entry", "icon", "hosts", "captcha"}
	hostKeys        = []string{"connect", "images", "media"}
)

// ValidID reports whether id may name an extension.
func ValidID(id string) bool { return idPattern.MatchString(id) && !reservedIDs[id] }

func badManifest(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrBadManifest, fmt.Sprintf(format, args...))
}

// ParseManifest reads and validates a juntos.json; every error wraps
// ErrBadManifest and says which field is wrong.
func ParseManifest(raw []byte) (Manifest, error) {
	// encoding/json matches keys without regard to case and the last one wins,
	// where the extension host and the page only see the exact key: a manifest
	// they would read differently is refused. The same rules, case by case,
	// are in extensions/manifest-cases.json.
	if err := exactKeys(raw); err != nil {
		return Manifest{}, err
	}
	var m Manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return Manifest{}, badManifest("not json")
	}
	if !ValidID(m.ID) {
		return Manifest{}, badManifest("id")
	}
	if m.Name = strings.TrimSpace(m.Name); m.Name == "" || utf8.RuneCountInString(m.Name) > maxNameLen {
		return Manifest{}, badManifest("name")
	}
	if m.Version == "" || utf8.RuneCountInString(m.Version) > maxVersionLen {
		return Manifest{}, badManifest("version")
	}
	if m.Protocol != 1 {
		return Manifest{}, badManifest("protocol")
	}
	if !relativePath(m.Entry) || path.Ext(m.Entry) != ".html" {
		return Manifest{}, badManifest("entry")
	}
	if m.Icon != "" {
		ext := path.Ext(m.Icon)
		if !relativePath(m.Icon) || (ext != ".png" && ext != ".svg") {
			return Manifest{}, badManifest("icon")
		}
	}
	if m.Captcha != "" && m.Captcha != "hcaptcha" {
		return Manifest{}, badManifest("captcha")
	}
	for _, list := range []struct {
		name     string
		hosts    []string
		wildcard bool
	}{{"connect", m.Hosts.Connect, false}, {"images", m.Hosts.Images, false}, {"media", m.Hosts.Media, true}} {
		if len(list.hosts) > maxHostsPerList {
			return Manifest{}, badManifest("hosts.%s: more than %d", list.name, maxHostsPerList)
		}
		// ["*"], alone, is any host: an extension that reaches what the person tells it to.
		if len(list.hosts) == 1 && list.hosts[0] == AnyHost {
			continue
		}
		for _, host := range list.hosts {
			if !validHost(host, list.wildcard) {
				return Manifest{}, badManifest("hosts.%s: %q", list.name, host)
			}
		}
	}
	for _, list := range []*[]string{&m.Hosts.Connect, &m.Hosts.Images, &m.Hosts.Media} {
		if *list == nil {
			*list = []string{}
		}
	}
	return m, nil
}

// exactKeys refuses a known key spelled with other case, at the top and in hosts.
func exactKeys(raw []byte) error {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil {
		return badManifest("not an object")
	}
	if err := keysAsSpelled(top, manifestKeys); err != nil {
		return err
	}
	var hosts map[string]json.RawMessage
	if json.Unmarshal(top["hosts"], &hosts) == nil {
		return keysAsSpelled(hosts, hostKeys)
	}
	return nil
}

func keysAsSpelled(object map[string]json.RawMessage, known []string) error {
	for key := range object {
		for _, want := range known {
			if key != want && strings.EqualFold(key, want) {
				return badManifest("key %q", key)
			}
		}
	}
	return nil
}

// relativePath is a path inside the extension that the extension host will
// serve: no scheme, no root, no hidden segment, no way up.
func relativePath(p string) bool {
	if p == "" || len(p) > maxPathLen {
		return false
	}
	for _, segment := range strings.Split(p, "/") {
		if !segmentPattern.MatchString(segment) || strings.Contains(segment, "..") {
			return false
		}
	}
	return true
}

// validHost is a public DNS name, without scheme, port or path; "*.domain"
// only where wildcard is allowed, and never on a bare top-level domain.
func validHost(host string, wildcard bool) bool {
	if wildcard && strings.HasPrefix(host, "*.") {
		host = strings.TrimPrefix(host, "*.")
	}
	if len(host) > 253 || net.ParseIP(strings.Trim(host, "[]")) != nil {
		return false
	}
	labels := strings.Split(host, ".")
	if len(labels) < 2 {
		return false
	}
	for _, label := range labels {
		if !labelPattern.MatchString(label) {
			return false
		}
	}
	if labels[len(labels)-1] == "localhost" {
		return false
	}
	for _, domain := range reservedDomains {
		if host == domain || strings.HasSuffix(host, "."+domain) {
			return false
		}
	}
	return true
}

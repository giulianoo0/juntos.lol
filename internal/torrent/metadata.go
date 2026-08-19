package torrent

import (
	"encoding/base64"
	"net/url"
	"sort"
	"strings"
)

// encodeMetadata renders a tus Upload-Metadata header. Keys are emitted in a
// stable order so the header is reproducible in tests.
func encodeMetadata(values map[string]string) string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	pairs := make([]string, 0, len(keys))
	for _, key := range keys {
		pairs = append(pairs, key+" "+base64.StdEncoding.EncodeToString([]byte(values[key])))
	}
	return strings.Join(pairs, ",")
}

// resolveLocation turns the Location of a created upload into an absolute URL.
// tusd normally answers with one already, but a relative value is legal and
// has to be read against the endpoint it came from.
func resolveLocation(endpoint, location string) string {
	base, err := url.Parse(endpoint)
	if err != nil {
		return location
	}
	resolved, err := base.Parse(location)
	if err != nil {
		return location
	}
	return resolved.String()
}

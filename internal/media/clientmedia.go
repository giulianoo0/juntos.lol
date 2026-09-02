package media

import (
	"regexp"
	"strings"
)

// The server's half of the client media pipeline: the object names it will
// sign, the playlists it will accept, and the rendering that keeps the one
// invariant this design hangs on — a viewer never gets a URL that 404s.

const (
	ClientSegmentContentType = "video/iso.segment"
	ClientInitContentType    = "video/mp4"
	ClientObjectCacheControl = "public, max-age=31536000, immutable"
	MaxClientPlaylistBytes   = 512 << 10
	MaxClientObjectBytes     = 256 << 20
)

var (
	clientObjectName   = regexp.MustCompile(`^(r\d{1,6}_)?(cinit_\d{1,4}\.mp4|cs_\d{1,4}_\d{1,7}\.m4s)$`)
	clientPlaylistName = regexp.MustCompile(`^((r\d{1,6}_)?master\.m3u8|(r\d{1,6}_)?client_stream_\d{1,4}\.m3u8)$`)
)

// ClientObjectContentType validates a client object name and answers the
// content type its presigned upload must carry. The name grammar is the
// authorization: nothing outside it ever gets signed.
func ClientObjectContentType(name string) (string, bool) {
	if !clientObjectName.MatchString(name) {
		return "", false
	}
	if strings.HasSuffix(name, ".mp4") {
		return ClientInitContentType, true
	}
	return ClientSegmentContentType, true
}

func ValidClientPlaylistName(name string) bool {
	return clientPlaylistName.MatchString(name)
}

var clientMediaTagAllowed = map[string]struct{}{
	"#EXTM3U":                       {},
	"#EXT-X-VERSION":                {},
	"#EXT-X-TARGETDURATION":         {},
	"#EXT-X-MEDIA-SEQUENCE":         {},
	"#EXT-X-PLAYLIST-TYPE":          {},
	"#EXT-X-INDEPENDENT-SEGMENTS":   {},
	"#EXT-X-START":                  {},
	"#EXT-X-MAP":                    {},
	"#EXTINF":                       {},
	"#EXT-X-PROGRAM-DATE-TIME":      {},
	"#EXT-X-DISCONTINUITY":          {},
	"#EXT-X-DISCONTINUITY-SEQUENCE": {},
	"#EXT-X-GAP":                    {},
	"#EXT-X-BITRATE":                {},
	"#EXT-X-ENDLIST":                {},
}

// tagName reads the tag off a playlist line: everything up to the first ':',
// or the whole line for a valueless tag.
func tagName(line string) string {
	if name, _, found := strings.Cut(line, ":"); found {
		return name
	}
	return line
}

// SanitizeClientMediaPlaylist rejects a client media playlist carrying any tag
// outside the allowlist, or a URI attribute on any tag other than EXT-X-MAP.
// Bare segment and playlist lines are the caller's to validate.
func SanitizeClientMediaPlaylist(body []byte) bool {
	for line := range strings.SplitSeq(string(body), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || !strings.HasPrefix(trimmed, "#") {
			continue
		}
		name := tagName(trimmed)
		if _, ok := clientMediaTagAllowed[name]; !ok {
			return false
		}
		if uris := strings.Count(trimmed, "URI="); uris > 0 && (name != "#EXT-X-MAP" || uris > 1) {
			return false
		}
	}
	return true
}

// ClientMasterVerdict is how a submitted master is judged: structurally sound
// or not, and — if sound — whether every playlist it names is available yet.
type ClientMasterVerdict int

const (
	ClientMasterInvalid ClientMasterVerdict = iota
	ClientMasterEarly
	ClientMasterReady
)

// JudgeClientMaster checks a client master playlist: allowlisted tags, every
// URI inside the client name grammar, never more than one URI on a line.
// A master naming a not-yet-available playlist is early, not invalid.
func JudgeClientMaster(body []byte, available func(name string) bool) ClientMasterVerdict {
	if !isMasterPlaylist(body) {
		return ClientMasterInvalid
	}
	ready := true
	for line := range strings.SplitSeq(string(body), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if !strings.HasPrefix(trimmed, "#") {
			if !clientPlaylistName.MatchString(trimmed) {
				return ClientMasterInvalid
			}
			if !available(trimmed) {
				ready = false
			}
			continue
		}
		if _, ok := clientMasterTagAllowed[tagName(trimmed)]; !ok {
			return ClientMasterInvalid
		}
		lower := strings.ToLower(trimmed)
		uriCount := strings.Count(lower, "uri=")
		if uriCount > 1 {
			return ClientMasterInvalid
		}
		if uriCount == 1 {
			uri, ok := mapURI(trimmed)
			if !ok || !clientPlaylistName.MatchString(uri) {
				return ClientMasterInvalid
			}
			if !available(uri) {
				ready = false
			}
		}
	}
	if !ready {
		return ClientMasterEarly
	}
	return ClientMasterReady
}

var clientMasterTagAllowed = map[string]struct{}{
	"#EXTM3U":                     {},
	"#EXT-X-VERSION":              {},
	"#EXT-X-INDEPENDENT-SEGMENTS": {},
	"#EXT-X-STREAM-INF":           {},
	"#EXT-X-MEDIA":                {},
	"#EXT-X-I-FRAME-STREAM-INF":   {},
}

// RenderClientPlaylist rewrites a client media playlist the way the publisher
// rewrites its own: bucket URLs prepended, list cut at the first unconfirmed
// segment. The returned refs are every object it named, confirmed or not.
func RenderClientPlaylist(baseURL, roomID string, generation int, body []byte,
	published map[string]struct{}) (rendered string, ok bool) {
	return renderPlaylistWithBase(baseURL, roomID, generation, body, published)
}

func ClientPlaylistObjects(body []byte) []string {
	return playlistObjects(body)
}

func IsMasterPlaylist(body []byte) bool {
	return isMasterPlaylist(body)
}

func HLSObjectKey(roomID string, generation int, name string) string {
	return hlsPrefix(roomID, generation) + name
}

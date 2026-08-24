package media

import (
	"regexp"
	"strings"
)

// The client media pipeline: a capable browser remuxes the source itself,
// PUTs segments straight into the bucket through presigned URLs, and hands
// the playlists to the server for validation and publication. Everything
// here is the server's half of that contract — the names it will sign, the
// playlists it will accept, and the rendering that keeps the one invariant
// this whole design hangs on: a viewer never gets a URL that 404s.

const (
	// ClientSegmentContentType and friends mirror what the publisher records
	// on its own uploads, so client-produced media is indistinguishable at
	// the edge.
	ClientSegmentContentType = "video/iso.segment"
	ClientInitContentType    = "video/mp4"
	ClientObjectCacheControl = "public, max-age=31536000, immutable"
	// MaxClientPlaylistBytes bounds one submitted playlist. The largest real
	// playlist — a two-hour film in four-second segments — is under 100 KB.
	MaxClientPlaylistBytes = 512 << 10
	// MaxClientObjectBytes bounds one presigned segment. A 4-second segment
	// of a very high bitrate remux stays far below this.
	MaxClientObjectBytes = 256 << 20
)

// Client-produced files live in their own namespace so they can never
// collide with anything ffmpeg writes into the same generation — the
// fallback path must be able to run over a half-finished client attempt.
var (
	// The optional r<N>_ prefix is a region: a contiguous stretch the host
	// pipeline produced from one seek target. Regions never reuse names, so a
	// restart can publish while the old region's objects still exist.
	clientObjectName   = regexp.MustCompile(`^(r\d{1,6}_)?(cinit_\d{1,4}\.mp4|cs_\d{1,4}_\d{1,7}\.m4s)$`)
	clientPlaylistName = regexp.MustCompile(`^(master\.m3u8|(r\d{1,6}_)?client_stream_\d{1,4}\.m3u8)$`)
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

// ValidClientPlaylistName reports whether the client may publish a playlist
// under this name.
func ValidClientPlaylistName(name string) bool {
	return clientPlaylistName.MatchString(name)
}

// clientMediaTagAllowed is the set of playlist tags a client may submit. A
// tag outside it is refused rather than copied through, so an attacker cannot
// smuggle EXT-X-KEY (an arbitrary decryption URL every viewer would fetch),
// EXT-X-DATERANGE (X-ASSET-URI), EXT-X-SESSION-DATA, or any future URI-bearing
// tag into a playlist the server signs off on and serves. The list covers
// exactly what mediabunny's CMAF/HLS muxer emits.
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

// SanitizeClientMediaPlaylist rejects a client media playlist that carries any
// tag outside the allowlist, or a URI attribute on any tag other than
// EXT-X-MAP (the one the server rewrites). Bare segment and playlist lines
// are the caller's to validate against the published set; this guards the
// tag lines the render step would otherwise copy verbatim.
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
		// Only EXT-X-MAP may carry a URI, and exactly one: a second URI= on
		// the same tag is the duplicate-key trick a lenient parser resolves to
		// the attacker's origin, and any URI on any other tag is a smuggled
		// fetch.
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
	// ClientMasterInvalid: a disallowed tag, a smuggled URI, or a name
	// outside the grammar. A 400, and the run should stop.
	ClientMasterInvalid ClientMasterVerdict = iota
	// ClientMasterEarly: sound, but it names a playlist that has no confirmed
	// segments yet. Skip it this round and accept it once the variant lands —
	// this is the state every run starts in, not an error.
	ClientMasterEarly
	// ClientMasterReady: sound and every named playlist is available.
	ClientMasterReady
)

// JudgeClientMaster checks a client master playlist: only the master's own
// allowlisted tags, every URI (bare line or attribute) inside the client
// name grammar, and never more than one URI on a line — a second URI= on the
// same tag is how a duplicate-key parser is tricked into resolving an
// attacker's origin. `available` reports whether a validly-named playlist has
// landed; a master naming a not-yet-available one is early, not invalid.
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
		// The master is served verbatim, so its URI attributes are checked
		// case-insensitively: any uri= token must be the quoted form the
		// server can parse, appear exactly once, and name a known local
		// playlist. An unquoted, lowercase, or duplicated URI is refused
		// rather than copied to every viewer's player.
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

// clientMasterTagAllowed is what a client master playlist may contain.
var clientMasterTagAllowed = map[string]struct{}{
	"#EXTM3U":                     {},
	"#EXT-X-VERSION":              {},
	"#EXT-X-INDEPENDENT-SEGMENTS": {},
	"#EXT-X-STREAM-INF":           {},
	"#EXT-X-MEDIA":                {},
	"#EXT-X-I-FRAME-STREAM-INF":   {},
}

// RenderClientPlaylist rewrites a client media playlist exactly the way the
// publisher rewrites its own: bucket URLs prepended, and the list cut at the
// first segment the published set has not confirmed. The returned refs are
// every object the submitted playlist named, confirmed or not.
func RenderClientPlaylist(baseURL, roomID string, generation int, body []byte,
	published map[string]struct{}) (rendered string, ok bool) {
	return renderPlaylistWithBase(baseURL, roomID, generation, body, published)
}

// ClientPlaylistObjects names every object a client media playlist
// references, for the acceptance check.
func ClientPlaylistObjects(body []byte) []string {
	return playlistObjects(body)
}

// IsMasterPlaylist says whether a submitted playlist is the master.
func IsMasterPlaylist(body []byte) bool {
	return isMasterPlaylist(body)
}

// HLSObjectKey is the bucket key for one client media object.
func HLSObjectKey(roomID string, generation int, name string) string {
	return hlsPrefix(roomID, generation) + name
}

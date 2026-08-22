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
	ClientSegmentContentType  = "video/iso.segment"
	ClientInitContentType     = "video/mp4"
	ClientObjectCacheControl  = "public, max-age=31536000, immutable"
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
	clientObjectName   = regexp.MustCompile(`^(cinit_\d{1,4}\.mp4|cs_\d{1,4}_\d{1,7}\.m4s)$`)
	clientPlaylistName = regexp.MustCompile(`^(master\.m3u8|client_stream_\d{1,4}\.m3u8)$`)
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

// ValidateClientMaster checks a client master playlist: every URI line must
// name a playlist the same submission (or an earlier one) is allowed to own.
// Tags pass through untouched — the client authored this ladder and the
// server has nothing smarter to say about its BANDWIDTH numbers.
func ValidateClientMaster(body []byte, playlistKnown func(name string) bool) bool {
	if !isMasterPlaylist(body) {
		return false
	}
	for line := range strings.SplitSeq(string(body), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			// EXT-X-MEDIA carries its playlist in a URI attribute.
			if uri, ok := mapURI(trimmed); ok && !playlistKnown(uri) {
				return false
			}
			continue
		}
		if !playlistKnown(trimmed) {
			return false
		}
	}
	return true
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

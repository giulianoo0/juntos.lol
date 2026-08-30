package room

import "time"

// TrackInfo describes one audio or subtitle track of the uploaded file.
//
// Digest names the bytes behind a subtitle track. A browser extraction
// republishes the whole set every few seconds as it finds more cues, but the
// tracks it already finished do not change — and a viewer that keys its
// <track> elements by a room-wide version refetches and reparses every one of
// them on each publish. Keyed by digest, only the track that actually grew
// moves. Empty for audio, and for subtitles a server extraction produced.
type TrackInfo struct {
	Index    int    `json:"index"`
	Language string `json:"language"`
	Title    string `json:"title"`
	Codec    string `json:"codec"`
	Digest   string `json:"digest,omitempty"`
}

// Chapter is one authored span of the media — an opening, a recap, the
// episode itself — read from the container's own chapter atoms.
type Chapter struct {
	StartMs int64  `json:"startMs"`
	EndMs   int64  `json:"endMs"`
	Title   string `json:"title,omitempty"`
}

// ChatMessage is a single chat entry in a room.
type ChatMessage struct {
	Author string    `json:"author"`
	Text   string    `json:"text"`
	At     time.Time `json:"at"`
}

// Member is a connected participant of a room.
type Member struct {
	ID       string    `json:"id"`
	Nickname string    `json:"nickname"`
	JoinedAt time.Time `json:"joinedAt"`
}

// PlayState is the shared playback position of a room.
type PlayState struct {
	Playing      bool    `json:"playing"`
	PositionMs   int64   `json:"positionMs"`
	Rate         float64 `json:"rate"`
	ServerTimeMs int64   `json:"serverTimeMs"`
}

// Source kinds a room can play. An uploaded file (a local pick or a torrent,
// which reaches the server through the same upload) drives the media pipeline;
// a shared screen bypasses it entirely and is carried live over WebRTC.
const (
	SourceUpload = "upload"
	SourceScreen = "screen"
)

// Room is the aggregate stored under room:{id}.
type Room struct {
	ID       string `json:"id"`
	FileName string `json:"fileName"`
	Status   string `json:"status"`
	// SourceKind is what the room is currently playing. Rooms created before
	// sources existed read back as an upload.
	SourceKind string `json:"sourceKind"`
	// MediaGeneration increments every time the controller swaps the source.
	// Clients compare it to decide that the media behind an unchanged URL is a
	// different recording and the player has to be torn down and rebuilt.
	MediaGeneration int `json:"mediaGeneration"`
	// MediaVersion increments every time the media behind the current
	// generation is republished in place — the final VOD remux replacing the
	// progressive preview. Players reload the same source URL when it moves,
	// so nobody keeps following playlists the pipeline has superseded.
	MediaVersion int `json:"mediaVersion"`
	// SubsVersion increments every time the subtitle files are rewritten.
	// Progressive browser extraction republishes the same file names with more
	// cues, and a <track> element only refetches when its URL changes.
	SubsVersion int `json:"subsVersion"`
	// GatingEnabled is the controller-owned setting that makes play and seek
	// wait until every member has buffered the target. Stored inverted
	// (gating_disabled) so rooms created before it existed read back as on.
	GatingEnabled bool `json:"gatingEnabled"`
	// DurationMs is the source's full duration as the host pipeline measured
	// it, published before the first segment lands. The player draws the whole
	// timeline from it instead of from how much media exists yet.
	DurationMs int64 `json:"durationMs,omitempty"`
	// MediaOffsetMs is where the current region's media timeline begins: the
	// pipeline rebases each region to zero, so absolute room time is media
	// time plus this. Moves only together with MediaVersion.
	MediaOffsetMs int64 `json:"mediaOffsetMs,omitempty"`
	// MediaRegions is every stretch of the timeline the pipeline has produced
	// for this generation, each with its own playlists (rN_master.m3u8). A
	// player picks the region for the time it wants and switches at the
	// edges; the offset above is only the one still growing.
	MediaRegions []MediaRegion `json:"mediaRegions,omitempty"`
	ErrorMessage string        `json:"errorMessage,omitempty"`
	ControllerID string        `json:"controllerId"`
	// SourceMemberID is the member whose browser holds the source and runs
	// the pipeline, and SourceOrigin is what they picked — "file", "torrent"
	// or "url". A file lives only in that one browser: when they leave, the
	// room has nothing left to play. Members can see who that is.
	SourceMemberID string `json:"sourceMemberId,omitempty"`
	SourceOrigin   string `json:"sourceOrigin,omitempty"`
	// OwnerToken is the secret handed to whoever created the room. A reload
	// mints a new member id, so this is the only thing that can tell the
	// server the host is back and hand control to them again. Never
	// serialized: every member reads the room, only one may hold this.
	OwnerToken     string      `json:"-"`
	AudioTracks    []TrackInfo `json:"audioTracks"`
	SubtitleTracks []TrackInfo `json:"subtitleTracks"`
	// Chapters are the source's authored spans, when it carries any: the
	// player draws them on the timeline so "the opening" is a place.
	Chapters          []Chapter `json:"chapters,omitempty"`
	BitmapSubsSkipped int       `json:"bitmapSubsSkipped"`
	ClientSubs        bool      `json:"clientSubs,omitempty"`
	// Preparation is how far the room is from being playable. It exists so a
	// viewer waiting on a source is told what is happening and roughly how
	// long, instead of watching a bar that fills to 100% and then sits there.
	Preparation Preparation `json:"preparation"`
	// ProducerHeartbeatMs is when the client pipeline holding this room's
	// claim last showed a sign of life, in Unix milliseconds; 0 when no claim
	// is held. It is what tells a cold seek apart from a dead room: a playhead
	// outside every produced region is normal while a pipeline is running —
	// it is on its way there — and only means the room needs picking up again
	// once nothing is producing. Cleared with the claim it belongs to.
	ProducerHeartbeatMs int64     `json:"producerHeartbeatMs,omitempty"`
	CreatedAt           time.Time `json:"createdAt"`
	ExpiresAt           time.Time `json:"expiresAt"`
}

// MediaSnapshot is the part of a room a publish can change, carried inside
// the update that announces it so a viewer applies it in place instead of
// fetching the whole room again.
type MediaSnapshot struct {
	MediaGeneration int           `json:"mediaGeneration"`
	MediaVersion    int           `json:"mediaVersion"`
	MediaOffsetMs   int64         `json:"mediaOffsetMs"`
	MediaRegions    []MediaRegion `json:"mediaRegions"`
}

// Snapshot is the room's media, as a publish leaves it.
func (r *Room) Snapshot() MediaSnapshot {
	return MediaSnapshot{
		MediaGeneration: r.MediaGeneration,
		MediaVersion:    r.MediaVersion,
		MediaOffsetMs:   r.MediaOffsetMs,
		MediaRegions:    r.MediaRegions,
	}
}

// MediaRegion is one contiguous stretch of produced media, in room time.
type MediaRegion struct {
	N          int   `json:"n"`
	StartMs    int64 `json:"startMs"`
	ProducedMs int64 `json:"producedMs"`
	Growing    bool  `json:"growing"`
}

// Preview phases a room passes through before it can play. They are ordered:
// bytes arrive, the container is analysed, the first segment is cut.
const (
	// PreviewReceiving means not enough of the source has arrived to analyse.
	PreviewReceiving = "receiving"
	// PreviewProbing means ffprobe has not yet made sense of what arrived.
	PreviewProbing = "probing"
	// PreviewSegmenting means ffmpeg is cutting the first playable segment.
	PreviewSegmenting = "segmenting"
	// PreviewUnavailable means this source cannot be previewed at all and
	// only becomes playable once the whole file has landed. An MP4 whose moov
	// atom sits after the media data is the usual reason: nothing can be
	// decoded until the very end of the file arrives.
	PreviewUnavailable = "unavailable"
)

// Preparation is the progress of turning a source into playable media.
type Preparation struct {
	// SourceBytes is the size of the incoming file, 0 when unknown.
	SourceBytes int64 `json:"sourceBytes,omitempty"`
	// ReceivedBytes is how much of it the server holds.
	ReceivedBytes int64 `json:"receivedBytes,omitempty"`
	// PreviewPhase is one of the Preview* constants, empty before the first
	// byte arrives.
	PreviewPhase string `json:"previewPhase,omitempty"`
	// PreviewTargetBytes is how much of the source is expected to be needed
	// before the first segment can be published, derived from the measured
	// bitrate. 0 while unknown, and meaningless once the phase is
	// PreviewUnavailable, where the answer is the whole file.
	PreviewTargetBytes int64 `json:"previewTargetBytes,omitempty"`
	// Swarm is the torrent behind the source as its worker last reported
	// it, so every viewer sees the peers and the speed, not only the host.
	Swarm *SwarmStats `json:"swarm,omitempty"`
}

// SwarmStats is what a worker reports about a torrent it is fetching.
type SwarmStats struct {
	Peers         int64 `json:"peers"`
	DownSpeed     int64 `json:"downSpeed"`
	HaveBytes     int64 `json:"haveBytes"`
	SelectedBytes int64 `json:"selectedBytes"`
	// DiskBytes is what the worker's disk is really holding for this torrent.
	// HaveBytes only ever grows — it counts what came off the swarm over the
	// torrent's life — while the window hands blocks back as the reader passes
	// them, so the two answer different questions and only this one is storage.
	DiskBytes int64 `json:"diskBytes"`
}

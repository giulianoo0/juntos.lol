package room

import "time"

// TrackInfo describes one audio or subtitle track of the uploaded file.
// Digest names the bytes behind a subtitle track, so a viewer keying its
// <track> elements by it only refetches the track that actually grew. Empty
// for audio and for server-extracted subtitles.
type TrackInfo struct {
	Index    int    `json:"index"`
	Language string `json:"language"`
	Title    string `json:"title"`
	Codec    string `json:"codec"`
	Digest   string `json:"digest,omitempty"`
}

// SubtitleFont is one font file the source attached for its styled (ASS)
// tracks. File is its digest-derived name under the generation's subs/fonts/
// prefix; Name is what the container called it.
type SubtitleFont struct {
	Name string `json:"name"`
	File string `json:"file"`
	Size int64  `json:"size"`
}

// Chapter is one authored span of the media — an opening, a recap, the
// episode itself — read from the container's own chapter atoms.
type Chapter struct {
	StartMs int64  `json:"startMs"`
	EndMs   int64  `json:"endMs"`
	Title   string `json:"title,omitempty"`
}

type ChatMessage struct {
	Author string    `json:"author"`
	Text   string    `json:"text"`
	At     time.Time `json:"at"`
}

type Member struct {
	ID       string    `json:"id"`
	Nickname string    `json:"nickname"`
	JoinedAt time.Time `json:"joinedAt"`
	// What the member says their microphone and camera are doing, and whether
	// the host turned either off for them.
	Mic        bool `json:"mic,omitempty"`
	Cam        bool `json:"cam,omitempty"`
	HostMuted  bool `json:"hostMuted,omitempty"`
	HostCamOff bool `json:"hostCamOff,omitempty"`
}

// ScreenShare is one member publishing their screen to the room right now.
// The relay announces nothing, so this list is the only thing telling a
// viewer which broadcasts exist and whose they are.
type ScreenShare struct {
	MemberID string    `json:"memberId"`
	Nickname string    `json:"nickname"`
	Since    time.Time `json:"since"`
}

type PlayState struct {
	Playing      bool    `json:"playing"`
	PositionMs   int64   `json:"positionMs"`
	Rate         float64 `json:"rate"`
	ServerTimeMs int64   `json:"serverTimeMs"`
}

// StatusEmpty is the media stage of a room nobody has opened anything in:
// a room is born this way, and its screens and live play beside it.
const StatusEmpty = "empty"

// The kinds of stage a room shows side by side: one media with a timeline
// (file, torrent, YouTube video), one live, and up to MaxScreenShares
// screens. A member is not a stage, but a spotlight can point at one.
const (
	StageMedia  = "media"
	StageLive   = "live"
	StageScreen = "screen"
	StageMember = "member"
)

// Spotlight is what the host puts in front of everyone. MemberID names the
// screen's owner, or the member, for those two kinds.
type Spotlight struct {
	Kind     string `json:"kind"`
	MemberID string `json:"memberId,omitempty"`
}

// LiveInfo describes the live a room is on and who puts it on the relay.
// Status follows the producer (processing, ready, error) apart from the
// media's, since the two play at once.
type LiveInfo struct {
	VideoID   string `json:"videoId"`
	Title     string `json:"title"`
	Thumbnail string `json:"thumbnail,omitempty"`
	// Producer is "fleet" (a worker) or "jlocal" (the host's companion app).
	Producer  string `json:"producer"`
	Broadcast string `json:"broadcast"`
	WorkerID  string `json:"workerId,omitempty"`
	JobID     string `json:"jobId,omitempty"`
	// MemberID opened the live and may run it besides the host.
	MemberID string `json:"memberId,omitempty"`
	Status   string `json:"status,omitempty"`
	Error    string `json:"error,omitempty"`
}

// Room is the aggregate stored under room:{id}.
type Room struct {
	ID                  string         `json:"id"`
	Name                string         `json:"name,omitempty"`
	FileName            string         `json:"fileName"`
	Status              string         `json:"status"`
	MediaGeneration     int            `json:"mediaGeneration"`
	MediaVersion        int            `json:"mediaVersion"`
	SubsVersion         int            `json:"subsVersion"`
	GatingEnabled       bool           `json:"gatingEnabled"`
	DurationMs          int64          `json:"durationMs,omitempty"`
	MediaOffsetMs       int64          `json:"mediaOffsetMs,omitempty"`
	MediaRegions        []MediaRegion  `json:"mediaRegions,omitempty"`
	ErrorMessage        string         `json:"errorMessage,omitempty"`
	ControllerID        string         `json:"controllerId"`
	SourceMemberID      string         `json:"sourceMemberId,omitempty"`
	SourceOrigin        string         `json:"sourceOrigin,omitempty"`
	OwnerToken          string         `json:"-"`
	AudioTracks         []TrackInfo    `json:"audioTracks"`
	SubtitleTracks      []TrackInfo    `json:"subtitleTracks"`
	SubtitleFonts       []SubtitleFont `json:"subtitleFonts,omitempty"`
	Chapters            []Chapter      `json:"chapters,omitempty"`
	BitmapSubsSkipped   int            `json:"bitmapSubsSkipped"`
	ClientSubs          bool           `json:"clientSubs,omitempty"`
	Preparation         Preparation    `json:"preparation"`
	ProducerHeartbeatMs int64          `json:"producerHeartbeatMs,omitempty"`
	Screens             []ScreenShare  `json:"screens,omitempty"`
	Live                *LiveInfo      `json:"live,omitempty"`
	Spotlight           *Spotlight     `json:"spotlight,omitempty"`
	CreatedAt           time.Time      `json:"createdAt"`
	ExpiresAt           time.Time      `json:"expiresAt"`

	// JoinMode is how the room is entered: open, password or approval.
	JoinMode string `json:"joinMode,omitempty"`
}

// HasMedia reports whether the room's media stage holds a source, in any
// state from arriving to failed.
func (r *Room) HasMedia() bool {
	return r.Status != "" && r.Status != StatusEmpty
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

const (
	PreviewReceiving   = "receiving"
	PreviewProbing     = "probing"
	PreviewSegmenting  = "segmenting"
	PreviewUnavailable = "unavailable"
)

// Preparation is the progress of turning a source into playable media.
type Preparation struct {
	SourceBytes        int64       `json:"sourceBytes,omitempty"`
	ReceivedBytes      int64       `json:"receivedBytes,omitempty"`
	PreviewPhase       string      `json:"previewPhase,omitempty"`
	PreviewTargetBytes int64       `json:"previewTargetBytes,omitempty"`
	Swarm              *SwarmStats `json:"swarm,omitempty"`
}

// SwarmStats is what a worker reports about a torrent it is fetching.
type SwarmStats struct {
	Peers         int64 `json:"peers"`
	DownSpeed     int64 `json:"downSpeed"`
	HaveBytes     int64 `json:"haveBytes"`
	SelectedBytes int64 `json:"selectedBytes"`
	DiskBytes     int64 `json:"diskBytes"`
}

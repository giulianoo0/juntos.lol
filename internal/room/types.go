package room

import "time"

// TrackInfo describes one audio or subtitle track of the uploaded file.
type TrackInfo struct {
	Index    int    `json:"index"`
	Language string `json:"language"`
	Title    string `json:"title"`
	Codec    string `json:"codec"`
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
	SubsVersion       int         `json:"subsVersion"`
	ErrorMessage      string      `json:"errorMessage,omitempty"`
	ControllerID      string      `json:"controllerId"`
	AudioTracks       []TrackInfo `json:"audioTracks"`
	SubtitleTracks    []TrackInfo `json:"subtitleTracks"`
	BitmapSubsSkipped int         `json:"bitmapSubsSkipped"`
	ClientSubs        bool        `json:"clientSubs,omitempty"`
	CreatedAt         time.Time   `json:"createdAt"`
	ExpiresAt         time.Time   `json:"expiresAt"`
}

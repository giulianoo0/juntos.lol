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

// Room is the aggregate stored under room:{id}.
type Room struct {
	ID                string      `json:"id"`
	FileName          string      `json:"fileName"`
	Status            string      `json:"status"`
	ErrorMessage      string      `json:"errorMessage,omitempty"`
	ControllerID      string      `json:"controllerId"`
	AudioTracks       []TrackInfo `json:"audioTracks"`
	SubtitleTracks    []TrackInfo `json:"subtitleTracks"`
	BitmapSubsSkipped int         `json:"bitmapSubsSkipped"`
	ClientSubs        bool        `json:"clientSubs,omitempty"`
	CreatedAt         time.Time   `json:"createdAt"`
	ExpiresAt         time.Time   `json:"expiresAt"`
}

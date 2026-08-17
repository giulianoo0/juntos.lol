package room

import "time"

// TrackInfo describes one audio or subtitle track of the uploaded file.
type TrackInfo struct {
	Index    int
	Language string
	Title    string
	Codec    string
}

// ChatMessage is a single chat entry in a room.
type ChatMessage struct {
	Author string
	Text   string
	At     time.Time
}

// Member is a connected participant of a room.
type Member struct {
	ID       string
	Nickname string
	JoinedAt time.Time
}

// PlayState is the shared playback position of a room.
type PlayState struct {
	Playing      bool
	PositionMs   int64
	Rate         float64
	ServerTimeMs int64
}

// Room is the aggregate stored under room:{id}.
type Room struct {
	ID                string
	FileName          string
	Status            string
	ErrorMessage      string
	ControllerID      string
	AudioTracks       []TrackInfo
	SubtitleTracks    []TrackInfo
	BitmapSubsSkipped int
	CreatedAt         time.Time
	ExpiresAt         time.Time
}

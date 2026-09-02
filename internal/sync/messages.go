package sync

import "github.com/giulianoo0/ss/internal/room"

// Inbound is a WebSocket message sent from a client to the server.
type Inbound struct {
	Type          string        `json:"type"`
	PositionMs    int64         `json:"positionMs,omitempty"`
	Rate          float64       `json:"rate,omitempty"`
	Text          string        `json:"text,omitempty"`
	Nickname      string        `json:"nickname,omitempty"`
	TargetID      string        `json:"targetId,omitempty"`
	ClientTimeMs  int64         `json:"clientTimeMs,omitempty"`
	OwnerToken    string        `json:"ownerToken,omitempty"`
	BufferAheadMs int64         `json:"bufferAheadMs,omitempty"`
	Stalled       bool          `json:"stalled,omitempty"`
	Enabled       *bool         `json:"enabled,omitempty"`
	Title         *TitleRequest `json:"title,omitempty"`
	Origin        string        `json:"origin,omitempty"`
}

// TitleRequest is a catalog title a viewer asks the controller to play. The
// server relays it verbatim after validation, filling From with the sender's
// nickname.
type TitleRequest struct {
	MetaID   string `json:"metaId"`
	MetaType string `json:"metaType"`
	Name     string `json:"name"`
	Poster   string `json:"poster,omitempty"`
	Season   int    `json:"season,omitempty"`
	Episode  int    `json:"episode,omitempty"`
	From     string `json:"from,omitempty"`
}

// Outbound is a WebSocket message sent from the server to clients.
type Outbound struct {
	Type         string              `json:"type"`
	MemberID     string              `json:"memberId,omitempty"`
	State        *room.PlayState     `json:"state,omitempty"`
	ControllerID string              `json:"controllerId,omitempty"`
	Members      []room.Member       `json:"members,omitempty"`
	Message      *room.ChatMessage   `json:"message,omitempty"`
	History      []room.ChatMessage  `json:"history,omitempty"`
	Status       string              `json:"status,omitempty"`
	ServerTimeMs int64               `json:"serverTimeMs,omitempty"`
	ClientTimeMs int64               `json:"clientTimeMs,omitempty"`
	ErrCode      string              `json:"error,omitempty"`
	Capability   string              `json:"capability,omitempty"`
	Readiness    []MemberReadiness   `json:"readiness,omitempty"`
	TargetMs     int64               `json:"targetMs,omitempty"`
	Media        *room.MediaSnapshot `json:"media,omitempty"`
	Gating       *bool               `json:"gating,omitempty"`
	Title        *TitleRequest       `json:"title,omitempty"`
	DeadlineMs   int64               `json:"deadlineMs,omitempty"`
	closeAfter   bool
}

// MemberReadiness is one member's buffering picture during a gated start.
type MemberReadiness struct {
	MemberID      string `json:"memberId"`
	BufferAheadMs int64  `json:"bufferAheadMs"`
	Stalled       bool   `json:"stalled,omitempty"`
	Ready         bool   `json:"ready"`
	Ignored       bool   `json:"ignored,omitempty"`
}

package sync

import "github.com/giulianoo0/ss/internal/room"

// Inbound is a WebSocket message sent from a client to the server.
type Inbound struct {
	Type         string  `json:"type"`
	PositionMs   int64   `json:"positionMs,omitempty"`
	Rate         float64 `json:"rate,omitempty"`
	Text         string  `json:"text,omitempty"`
	Nickname     string  `json:"nickname,omitempty"`
	TargetID     string  `json:"targetId,omitempty"`
	ClientTimeMs int64   `json:"clientTimeMs,omitempty"`
	// BufferAheadMs and Stalled belong to "ready" reports: how much contiguous
	// buffer the client holds ahead of PositionMs, and whether it is stalled.
	BufferAheadMs int64 `json:"bufferAheadMs,omitempty"`
	Stalled       bool  `json:"stalled,omitempty"`
	// Enabled carries the "gating" room setting. A pointer so an absent field
	// is distinguishable from an explicit false.
	Enabled *bool `json:"enabled,omitempty"`
}

// Outbound is a WebSocket message sent from the server to clients.
type Outbound struct {
	Type         string             `json:"type"`
	MemberID     string             `json:"memberId,omitempty"`
	State        *room.PlayState    `json:"state,omitempty"`
	ControllerID string             `json:"controllerId,omitempty"`
	Members      []room.Member      `json:"members,omitempty"`
	Message      *room.ChatMessage  `json:"message,omitempty"`
	History      []room.ChatMessage `json:"history,omitempty"`
	Status       string             `json:"status,omitempty"`
	ServerTimeMs int64              `json:"serverTimeMs,omitempty"`
	ClientTimeMs int64              `json:"clientTimeMs,omitempty"`
	ErrCode      string             `json:"error,omitempty"`
	Capability   string             `json:"capability,omitempty"`
	// Readiness and TargetMs belong to "waiting" broadcasts while a gated
	// start is pending, so every member can see who is still buffering.
	Readiness []MemberReadiness `json:"readiness,omitempty"`
	TargetMs  int64             `json:"targetMs,omitempty"`
	// Gating carries the room's synchronized-start setting, in the welcome
	// frame and in "gating" broadcasts when the controller changes it.
	Gating *bool `json:"gating,omitempty"`
}

// MemberReadiness is one member's buffering picture during a gated start.
type MemberReadiness struct {
	MemberID      string `json:"memberId"`
	BufferAheadMs int64  `json:"bufferAheadMs"`
	Stalled       bool   `json:"stalled,omitempty"`
	Ready         bool   `json:"ready"`
	// Ignored marks a member the controller excused: the room no longer waits
	// for them, and they are shown as watching on their own.
	Ignored bool `json:"ignored,omitempty"`
}

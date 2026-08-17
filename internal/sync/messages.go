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
}

// Outbound is a WebSocket message sent from the server to clients.
type Outbound struct {
	Type         string             `json:"type"`
	State        *room.PlayState    `json:"state,omitempty"`
	ControllerID string             `json:"controllerId,omitempty"`
	Members      []room.Member      `json:"members,omitempty"`
	Message      *room.ChatMessage  `json:"message,omitempty"`
	History      []room.ChatMessage `json:"history,omitempty"`
	Status       string             `json:"status,omitempty"`
	ServerTimeMs int64              `json:"serverTimeMs,omitempty"`
	ClientTimeMs int64              `json:"clientTimeMs,omitempty"`
	ErrCode      string             `json:"error,omitempty"`
}

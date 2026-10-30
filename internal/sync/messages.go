package sync

import (
	"encoding/json"

	"github.com/giulianoo0/ss/internal/room"
)

// Inbound is a WebSocket message sent from a client to the server.
type Inbound struct {
	Type          string  `json:"type"`
	PositionMs    int64   `json:"positionMs,omitempty"`
	Rate          float64 `json:"rate,omitempty"`
	Text          string  `json:"text,omitempty"`
	Nickname      string  `json:"nickname,omitempty"`
	TargetID      string  `json:"targetId,omitempty"`
	ClientTimeMs  int64   `json:"clientTimeMs,omitempty"`
	OwnerToken    string  `json:"ownerToken,omitempty"`
	BufferAheadMs int64   `json:"bufferAheadMs,omitempty"`
	Stalled       bool    `json:"stalled,omitempty"`
	// What the viewer's player measured, carried on ready reports for the logs:
	// fragment throughput, the media's bitrate, and the decoder's frame counts.
	BandwidthKbps int64         `json:"bandwidthKbps,omitempty"`
	MediaKbps     int64         `json:"mediaKbps,omitempty"`
	DroppedFrames int64         `json:"droppedFrames,omitempty"`
	DecodedFrames int64         `json:"decodedFrames,omitempty"`
	Enabled       *bool         `json:"enabled,omitempty"`
	Title         *TitleRequest `json:"title,omitempty"`
	Origin        string        `json:"origin,omitempty"`
	// Subtitles is the controller's current subtitle pick, for viewers who
	// choose to copy it.
	Subtitles *HostSubtitles `json:"subtitles,omitempty"`
	// MemberID and Capability on a hello ask for the seat a dropped socket
	// held; the server hands it back while it is still being kept.
	MemberID   string `json:"memberId,omitempty"`
	Capability string `json:"capability,omitempty"`
	// Device on a hello names the browser, the same in all its tabs; it is
	// kept secret, so it never goes out to anyone.
	Device string `json:"device,omitempty"`
	// Kind names a stage (media, live, screen; member too for a spotlight)
	// on stageRequest, stageClose and spotlight; RequestID and Allow are the
	// host's stageAnswer.
	Kind      string `json:"kind,omitempty"`
	RequestID string `json:"requestId,omitempty"`
	Allow     bool   `json:"allow,omitempty"`
	// Mic and Cam on a media message; a field left out keeps its value.
	Mic *bool `json:"mic,omitempty"`
	Cam *bool `json:"cam,omitempty"`
	// Ticket on a hello is the proof a password room's password was given.
	Ticket string `json:"ticket,omitempty"`
	// Avatar on a hello is the one a guest picked; an account's own wins.
	Avatar string `json:"avatar,omitempty"`
	// Client and Features on a hello say what is on the other end: "desktop"
	// for the app, and "localSource" when it can play a source it opened
	// from its own cache. They change what the room asks of it, never what it may do.
	Client   string   `json:"client,omitempty"`
	Features []string `json:"features,omitempty"`
}

// decodeHello reads the first message of a socket, which must be a hello
// with a nickname fit to show.
func decodeHello(data []byte) (Inbound, bool) {
	var hello Inbound
	if err := json.Unmarshal(data, &hello); err != nil {
		return Inbound{}, false
	}
	if hello.Type != "hello" || !validNickname(hello.Nickname) {
		return Inbound{}, false
	}
	// Too short to be a secret: the hello joins as if it named none.
	if len(hello.Device) < 16 || len(hello.Device) > 64 {
		hello.Device = ""
	}
	return hello, true
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

// HostSubtitles is which subtitle track the controller watches with and how
// far it shifted it. Track is the room track index, or -1 for none; local
// imports never leave the host's browser, so those arrive as -1 too.
type HostSubtitles struct {
	Track   int   `json:"track"`
	DelayMs int64 `json:"delayMs"`
}

// Outbound is a WebSocket message sent from the server to clients.
type Outbound struct {
	Type          string              `json:"type"`
	MemberID      string              `json:"memberId,omitempty"`
	State         *room.PlayState     `json:"state,omitempty"`
	ControllerID  string              `json:"controllerId,omitempty"`
	Members       []room.Member       `json:"members,omitempty"`
	Message       *room.ChatMessage   `json:"message,omitempty"`
	History       []room.ChatMessage  `json:"history,omitempty"`
	Status        string              `json:"status,omitempty"`
	ServerTimeMs  int64               `json:"serverTimeMs,omitempty"`
	ClientTimeMs  int64               `json:"clientTimeMs,omitempty"`
	ErrCode       string              `json:"error,omitempty"`
	Capability    string              `json:"capability,omitempty"`
	Readiness     []MemberReadiness   `json:"readiness,omitempty"`
	TargetMs      int64               `json:"targetMs,omitempty"`
	Media         *room.MediaSnapshot `json:"media,omitempty"`
	Gating        *bool               `json:"gating,omitempty"`
	Title         *TitleRequest       `json:"title,omitempty"`
	DeadlineMs    int64               `json:"deadlineMs,omitempty"`
	HostSubtitles *HostSubtitles      `json:"hostSubtitles,omitempty"`
	RequestID     string              `json:"requestId,omitempty"`
	Kind          string              `json:"kind,omitempty"`
	Nickname      string              `json:"nickname,omitempty"`
	Allow         *bool               `json:"allow,omitempty"`
	Spotlight     *room.Spotlight     `json:"spotlight,omitempty"`
	// Mic and Cam on a forceMedia: what the host just turned off for this member.
	Mic *bool `json:"mic,omitempty"`
	Cam *bool `json:"cam,omitempty"`
	// Generation on a needBrowserMedia: the media the browsers are waiting for.
	Generation int `json:"generation,omitempty"`
	// Set on an event from outside the loop that only the host may see.
	toController bool
	closeAfter   bool
	// Set on the reset that follows a swap of the media stage.
	mediaChanged bool
}

// MemberReadiness is one member's buffering picture during a gated start.
type MemberReadiness struct {
	MemberID      string `json:"memberId"`
	BufferAheadMs int64  `json:"bufferAheadMs"`
	Stalled       bool   `json:"stalled,omitempty"`
	Ready         bool   `json:"ready"`
	Ignored       bool   `json:"ignored,omitempty"`
}

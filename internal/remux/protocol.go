// Package remux holds the versioned contract of the remote remux pipeline:
// run states, the payloads the API, the worker and the browser exchange, and
// the codec policy. The same shapes exist in TypeScript and Rust; a change
// here is a protocol change and bumps ProtocolVersion.
package remux

import "fmt"

const ProtocolVersion = 1

const (
	RunStarting   = "starting"
	RunAccepted   = "accepted"
	RunRunning    = "running"
	RunDraining   = "draining"
	RunCompleted  = "completed"
	RunCancelling = "cancelling"
	RunCancelled  = "cancelled"
	RunFailed     = "failed"
)

func TerminalState(state string) bool {
	return state == RunCompleted || state == RunCancelled || state == RunFailed
}

// StartRequest is POST /api/torrents/:jobId/remux. Authorization is exactly
// one of OwnerToken (room bootstrap) or MemberID+Capability (connected
// controller), and both require the session that owns the torrent job.
type StartRequest struct {
	RoomID          string    `json:"roomId" binding:"required"`
	MediaGeneration int       `json:"mediaGeneration"`
	RequestID       string    `json:"requestId" binding:"required"`
	StartMs         int64     `json:"startMs"`
	Auth            StartAuth `json:"auth"`
}

// StartAuth carries exactly one of the two authorization modes.
type StartAuth struct {
	OwnerToken string `json:"ownerToken,omitempty"`
	MemberID   string `json:"memberId,omitempty"`
	Capability string `json:"capability,omitempty"`
}

// StartResponse is the 202 body: accepted is not ready, and not running.
type StartResponse struct {
	Remote          bool   `json:"remote"`
	RunID           string `json:"runId"`
	MediaGeneration int    `json:"mediaGeneration"`
	State           string `json:"state"`
}

// Spec is the remux block of a signed worker job (kind "remuxStart"): only
// the payload the remux supervisor consumes, under the envelope's signature.
type Spec struct {
	ProtocolVersion int    `json:"protocolVersion"`
	RunID           string `json:"runId"`
	Claim           string `json:"claim"`
	MediaGeneration int    `json:"mediaGeneration"`
	Region          int    `json:"region"`
	StartMs         int64  `json:"startMs"`
	EndMs           int64  `json:"endMs,omitempty"`
	APIBase         string `json:"apiBase"`
	RoomID          string `json:"roomId"`
	Limits          Limits `json:"limits"`
}

// Limits are the backend-signed ceilings for one run. The worker clamps
// each to its own local configuration: a signed limit can lower a local
// ceiling, never raise it.
type Limits struct {
	PutConcurrency int   `json:"putConcurrency"`
	SpoolBytes     int64 `json:"spoolBytes"`
	ObjectBytes    int64 `json:"objectBytes"`
	AheadMs        int64 `json:"aheadMs"`
}

// Capability is what a worker announces in its heartbeat when it can run
// remote remux. Absent means it cannot, and it receives no remux jobs.
type Capability struct {
	ProtocolVersion int         `json:"protocolVersion"`
	Slots           int         `json:"slots"`
	ActiveRuns      int         `json:"activeRuns"`
	FFmpeg          string      `json:"ffmpeg"`
	AudioCodecs     []string    `json:"audioCodecs"`
	Runs            []RunReport `json:"runs,omitempty"`
}

// RunReport is one run's state as the worker last told it.
type RunReport struct {
	RunID      string `json:"runId"`
	State      string `json:"state"`
	ProducedMs int64  `json:"producedMs"`
	Error      string `json:"error,omitempty"`
}

// Compatible reports whether the backend may dispatch a remux job here.
func (c *Capability) Compatible() bool {
	return c != nil && c.ProtocolVersion == ProtocolVersion && c.FFmpeg != "" && c.Slots > 0
}

// Event is a worker→backend status report on the worker link (type
// "remuxEvent"). Media publication does not ride here — it goes through the
// claim-authenticated publish endpoint; this is lifecycle only.
type Event struct {
	Type            string `json:"type"`
	WorkerID        string `json:"workerId"`
	JobID           string `json:"jobId"`
	RunID           string `json:"runId"`
	MediaGeneration int    `json:"mediaGeneration"`
	Seq             int64  `json:"seq"`
	State           string `json:"state"`
	Error           string `json:"error,omitempty"`
	ProducedMs      int64  `json:"producedMs,omitempty"`
}

type VideoVerdict int

const (
	VideoCopy VideoVerdict = iota
	VideoReject
)

// VideoPolicy copies H264 and HEVC — whether a device decodes HEVC is the
// player's problem — and rejects everything else: no hidden video transcode.
func VideoPolicy(codec string) VideoVerdict {
	switch codec {
	case "h264", "avc":
		return VideoCopy
	case "hevc", "h265":
		return VideoCopy
	default:
		return VideoReject
	}
}

type AudioVerdict int

const (
	AudioCopy AudioVerdict = iota
	AudioConvert
	AudioReject
)

const maxAudioChannels = 8

// AudioPolicy decides copy/convert/reject for one track: AAC copies, the
// codecs with a matrix entry convert to AAC, anything else is refused.
func AudioPolicy(codec string, channels int) (AudioVerdict, error) {
	if channels <= 0 || channels > maxAudioChannels {
		return AudioReject, fmt.Errorf("audio layout with %d channels is outside the supported range", channels)
	}
	switch codec {
	case "aac":
		return AudioCopy, nil
	case "ac3", "eac3", "dts", "dca", "opus", "flac", "mp3", "vorbis":
		return AudioConvert, nil
	default:
		return AudioReject, fmt.Errorf("audio codec %q has no matrix entry", codec)
	}
}

// AACBitrateFor is the conversion bitrate per validated layout, in bits per
// second. Stereo and mono ride 160k; 5.1 and up ride 384k.
func AACBitrateFor(channels int) int {
	if channels <= 2 {
		return 160_000
	}
	return 384_000
}

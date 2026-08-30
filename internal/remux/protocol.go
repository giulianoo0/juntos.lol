// Package remux holds the versioned contract of the remote remux pipeline:
// the states a run moves through, the payloads the API, the worker and the
// browser exchange, and the codec policy that decides what a worker may copy,
// what it must convert, and what it refuses. The same shapes exist in
// TypeScript (web/src/pipeline/remoteRemuxTypes.ts) and Rust
// (ss-worker/src/remux/protocol.rs); a change here is a protocol change and
// bumps ProtocolVersion.
package remux

import "fmt"

// ProtocolVersion is the remote-remux protocol this build speaks. A worker
// announces the versions it accepts in its heartbeat; the backend only
// dispatches remux jobs to a worker whose announced version matches.
const ProtocolVersion = 1

// Run states. A run is one execution of FFmpeg over one region of one
// source generation; seeks outside coverage create a new run, source swaps
// create a new generation.
const (
	RunStarting   = "starting"   // reserved and persisted, dispatch not yet acknowledged
	RunAccepted   = "accepted"   // worker acknowledged; process may not have produced anything
	RunRunning    = "running"    // worker reported produced output
	RunDraining   = "draining"   // producer finished, uploads/confirms still landing
	RunCompleted  = "completed"  // media publishable and drained; receipt stored
	RunCancelling = "cancelling" // revoked, worker told to stop
	RunCancelled  = "cancelled"  // worker confirmed teardown
	RunFailed     = "failed"     // terminal error, visible to the room
)

// TerminalState reports whether a run state can never change again.
func TerminalState(state string) bool {
	return state == RunCompleted || state == RunCancelled || state == RunFailed
}

// StartRequest is POST /api/torrents/:jobId/remux. Authorization is one of
// two mutually exclusive modes: OwnerToken at room bootstrap (before the
// host's WebSocket exists), or MemberID+Capability for a connected
// controller swapping sources. Both additionally require the session that
// owns the torrent job.
type StartRequest struct {
	RoomID          string    `json:"roomId" binding:"required"`
	MediaGeneration int       `json:"mediaGeneration"`
	// RequestID is stable across retries: the same id with the same logical
	// payload returns the same run, a different payload conflicts.
	RequestID string     `json:"requestId" binding:"required"`
	StartMs   int64      `json:"startMs"`
	Auth      StartAuth  `json:"auth"`
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

// Spec is the remux block of a signed worker job (kind "remuxStart"). The
// envelope's own signature, nonce, expiry and workerId still apply; this is
// only the payload the remux supervisor consumes.
type Spec struct {
	ProtocolVersion int    `json:"protocolVersion"`
	RunID           string `json:"runId"`
	// Claim is the internal publish credential, minted per run, never sent
	// to a browser and redacted from logs.
	Claim           string `json:"claim"`
	MediaGeneration int    `json:"mediaGeneration"`
	Region          int    `json:"region"`
	StartMs         int64  `json:"startMs"`
	// EndMs bounds a fill region; 0 means run to the end of the file.
	EndMs int64 `json:"endMs,omitempty"`
	// APIBase is where the worker publishes: presign/publish/metadata. It
	// comes from server configuration, never from a client.
	APIBase string `json:"apiBase"`
	// RoomID scopes the publish endpoints the worker calls.
	RoomID string `json:"roomId"`
	Limits Limits `json:"limits"`
}

// Limits are the backend-signed ceilings for one run. The worker clamps
// each to its own local configuration: a signed limit can lower a local
// ceiling, never raise it.
type Limits struct {
	// PutConcurrency is simultaneous R2 PUTs for this job.
	PutConcurrency int `json:"putConcurrency"`
	// SpoolBytes bounds the closed-segment spool on disk.
	SpoolBytes int64 `json:"spoolBytes"`
	// ObjectBytes bounds one output object; larger fails the run.
	ObjectBytes int64 `json:"objectBytes"`
	// AheadMs is how far past the room's playhead production may run at
	// full speed before throttling to share capacity.
	AheadMs int64 `json:"aheadMs"`
}

// Capability is what a worker announces in its heartbeat when it can run
// remote remux. Absent means it cannot, and it receives no remux jobs.
type Capability struct {
	ProtocolVersion int `json:"protocolVersion"`
	// Slots is how many concurrent remux runs the worker will accept.
	Slots int `json:"slots"`
	// ActiveRuns is how many it is executing right now.
	ActiveRuns int `json:"activeRuns"`
	// FFmpeg identifies the pinned binary ("7.1-static" etc). Empty means
	// no usable binary and the capability is void.
	FFmpeg string `json:"ffmpeg"`
	// AudioCodecs lists source audio codecs it can convert to AAC.
	AudioCodecs []string `json:"audioCodecs"`
	// Runs is every run the worker still remembers, live and terminal.
	Runs []RunReport `json:"runs,omitempty"`
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
	Type            string `json:"type"` // "remuxEvent"
	WorkerID        string `json:"workerId"`
	JobID           string `json:"jobId"`
	RunID           string `json:"runId"`
	MediaGeneration int    `json:"mediaGeneration"`
	// Seq orders events of one run; the backend drops late ones.
	Seq   int64  `json:"seq"`
	State string `json:"state"`
	Error string `json:"error,omitempty"`
	// ProducedMs is how much media the run has muxed (not confirmed).
	ProducedMs int64 `json:"producedMs,omitempty"`
}

// --- Codec policy -----------------------------------------------------------
//
// The explicit compatibility matrix. Nothing outside it is ever accepted by
// analogy: an unlisted codec is a clear refusal, not a hidden transcode.

// VideoVerdict says what happens to a video stream.
type VideoVerdict int

const (
	VideoCopy VideoVerdict = iota
	VideoReject
)

// VideoPolicy: H264 is the reference and always copied. HEVC is copied —
// whether the viewer's device decodes it is the player's capability problem,
// the same as today's local pipeline, and remux never fixes it. Everything
// else is rejected: no hidden video transcode.
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

// AudioVerdict says what happens to an audio stream.
type AudioVerdict int

const (
	AudioCopy AudioVerdict = iota
	AudioConvert
	AudioReject
)

// maxAudioChannels is the largest layout the first version accepts for
// conversion. Larger layouts fail with a clear error; downmix is a product
// decision that has not been made.
const maxAudioChannels = 8

// AudioPolicy decides copy/convert/reject for one track. AAC copies when the
// layout is sane; AC3 and DTS convert to AAC. E-AC3, TrueHD, Opus and
// everything else reject explicitly — each needs its own matrix entry with
// its own validation before being promised.
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

// Package metrics declares every Prometheus series the server exports.
//
// They all live in one file on purpose. A metric is a contract with the
// dashboards and the alerts that read it, and the names, labels and buckets
// of that contract are far easier to keep coherent when they can be read
// side by side than when each package invents its own.
//
// Two rules run through the whole file. Anything that only ever grows is a
// counter, never a gauge and never a rate computed here: bandwidth, job
// throughput and bucket operations are all counters, and turning them into
// per-second figures is Grafana's job through rate(). And every label value
// comes from a closed set the code itself decides — a room id or a file name
// as a label value would mint a new time series per room, which is how a
// metrics endpoint quietly becomes the most expensive part of a server.
package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// namespace prefixes every series the application owns, so a dashboard can
// tell them apart from the Go runtime and process collectors that share the
// registry.
const namespace = "ss"

// Buckets are declared once and shared, so two histograms measuring the same
// kind of thing stay comparable and a dashboard can put them on one axis.
var (
	// httpBuckets span an API call: a playlist read is single-digit
	// milliseconds, a room creation a Redis round trip, an upload PATCH as
	// long as the body takes.
	httpBuckets = []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30}
	// storeBuckets span one call to the bucket. The floor is lower than the
	// HTTP one because a small object PUT is a single round trip, and the
	// ceiling is the upload timeout.
	storeBuckets = []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300}
	// jobBuckets span an ffmpeg run, which is seconds for a preview and up to
	// an hour for a full-length transcode.
	jobBuckets = []float64{1, 5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600}
	// previewBuckets span the wait a viewer actually feels: from the moment
	// the preview job starts to the moment the room can play.
	previewBuckets = []float64{1, 2, 5, 10, 15, 30, 45, 60, 120, 300, 600}
)

// Rooms.
var (
	// RoomsCreated counts rooms opened, by what they start out playing.
	//
	// PromQL: sum(rate(ss_rooms_created_total[5m])) * 3600
	RoomsCreated = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace,
		Name:      "rooms_created_total",
		Help:      "Rooms created, by source kind.",
	}, []string{"source_kind"})

	// RoomsActive is how many rooms exist right now. It is sampled from Redis
	// rather than counted in process: rooms expire on their own, and a
	// counter kept in memory would drift away from the truth within an hour.
	//
	// PromQL: ss_rooms_active
	RoomsActive = promauto.NewGauge(prometheus.GaugeOpts{
		Namespace: namespace,
		Name:      "rooms_active",
		Help:      "Rooms that currently exist, sampled from the store.",
	})

	// RoomsByState splits the same population by media status, which is what
	// says whether the pipeline is keeping up: a pile of rooms stuck in
	// "processing" is a queue problem, a pile in "error" is a source problem.
	//
	// PromQL: sum by (state) (ss_rooms_by_state)
	RoomsByState = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Namespace: namespace,
		Name:      "rooms_by_state",
		Help:      "Rooms that currently exist, by media status.",
	}, []string{"state"})

	// RoomsReclaimed counts rooms taken back, by what took them.
	//
	// PromQL: sum by (reason) (rate(ss_rooms_reclaimed_total[15m]))
	RoomsReclaimed = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace,
		Name:      "rooms_reclaimed_total",
		Help:      "Rooms reclaimed, by reason (idle, expired).",
	}, []string{"reason"})
)

// Reasons a room stops existing.
const (
	// ReclaimIdle is a room everyone left, taken back well before its TTL.
	ReclaimIdle = "idle"
	// ReclaimExpired is a room the sweeper took at the end of its TTL.
	ReclaimExpired = "expired"
)

// Participants and WebSocket connections.
//
// A participant and a connection are the same thing today — one browser tab
// holds one socket and counts as one member — but they are measured
// separately because they answer different questions: how many people are
// watching, and how much the hub is carrying.
var (
	// ParticipantsConnected is how many members are in rooms right now.
	//
	// PromQL: ss_participants_connected
	ParticipantsConnected = promauto.NewGauge(prometheus.GaugeOpts{
		Namespace: namespace,
		Name:      "participants_connected",
		Help:      "Members currently connected to a room.",
	})

	// ParticipantJoins counts accepted joins. A rejected one is not a join:
	// it is counted by outcome so a room hitting MAX_PARTICIPANTS is visible.
	//
	// PromQL: sum(rate(ss_participant_joins_total{outcome="joined"}[5m]))
	ParticipantJoins = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace,
		Name:      "participant_joins_total",
		Help:      "Attempts to join a room, by outcome.",
	}, []string{"outcome"})

	// ParticipantLeaves counts members leaving a room.
	//
	// PromQL: sum(rate(ss_participant_leaves_total[5m]))
	ParticipantLeaves = promauto.NewCounter(prometheus.CounterOpts{
		Namespace: namespace,
		Name:      "participant_leaves_total",
		Help:      "Members that left a room.",
	})

	// WebsocketConnections is how many sockets the hub is holding open.
	//
	// PromQL: ss_websocket_connections
	WebsocketConnections = promauto.NewGauge(prometheus.GaugeOpts{
		Namespace: namespace,
		Name:      "websocket_connections",
		Help:      "WebSocket connections currently open.",
	})

	// WebsocketMessages counts frames the hub handled. The type label is the
	// protocol's own closed set, and anything outside it is folded into
	// "other" rather than trusted: the inbound type comes off the wire.
	//
	// PromQL: sum by (direction) (rate(ss_websocket_messages_total[5m]))
	WebsocketMessages = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace,
		Name:      "websocket_messages_total",
		Help:      "WebSocket messages handled, by direction and message type.",
	}, []string{"direction", "type"})
)

// Outcomes of a join attempt.
const (
	// JoinAccepted is a member the room let in.
	JoinAccepted = "joined"
	// JoinRejected is a member the room turned away, full or failing.
	JoinRejected = "rejected"
)

// HTTP.
//
// Bytes are counted on the wire in both directions, which is what makes the
// upload and download bandwidth panels rate() of a counter rather than a
// number the application computes and hopes stays honest.
var (
	// HTTPRequests counts requests by route template, never by URL: the
	// template is a closed set the router already owns.
	//
	// PromQL: sum by (route) (rate(ss_http_requests_total{status=~"5.."}[5m]))
	HTTPRequests = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace,
		Name:      "http_requests_total",
		Help:      "HTTP requests served, by route template, method and status.",
	}, []string{"route", "method", "status"})

	// HTTPDuration measures how long a request took to serve.
	//
	// PromQL: histogram_quantile(0.95, sum by (le, route) (rate(ss_http_request_duration_seconds_bucket[5m])))
	HTTPDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Namespace: namespace,
		Name:      "http_request_duration_seconds",
		Help:      "Time to serve an HTTP request.",
		Buckets:   httpBuckets,
	}, []string{"route", "method"})

	// HTTPRequestBytes counts request body bytes read. The tus route is what
	// makes this the ingest side of the bandwidth panel.
	//
	// PromQL: sum(rate(ss_http_request_bytes_total[5m]))
	HTTPRequestBytes = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace,
		Name:      "http_request_bytes_total",
		Help:      "Request body bytes read, by route template.",
	}, []string{"route"})

	// HTTPResponseBytes counts response bytes written.
	//
	// This is the egress the application itself serves, which is playlists
	// and the frontend. Segments and subtitles leave from the bucket's edge
	// and never cross this process, so the bucket's own read operations are
	// what stands in for them.
	//
	// PromQL: sum(rate(ss_http_response_bytes_total[5m]))
	HTTPResponseBytes = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace,
		Name:      "http_response_bytes_total",
		Help:      "Response bytes written, by route template.",
	}, []string{"route"})

	// MediaBytesServed counts what the application hands a player directly.
	// It is separate from the route counter above because it is the number
	// that stays comparable if playlists ever move behind another route.
	//
	// PromQL: sum(rate(ss_media_bytes_served_total[5m]))
	MediaBytesServed = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace,
		Name:      "media_bytes_served_total",
		Help:      "Media bytes served by the application itself, by kind.",
	}, []string{"kind"})
)

// Uploads.
var (
	// UploadsInFlight is how many tus uploads are open: created, and neither
	// completed nor abandoned.
	//
	// PromQL: ss_uploads_in_flight
	UploadsInFlight = promauto.NewGauge(prometheus.GaugeOpts{
		Namespace: namespace,
		Name:      "uploads_in_flight",
		Help:      "tus uploads created and not yet completed or terminated.",
	})

	// UploadBytesReceived counts bytes stored by tus, taken from the store's
	// own confirmed offset rather than from the request body, so a retried
	// chunk is not counted twice.
	//
	// PromQL: sum(rate(ss_upload_bytes_received_total[5m]))
	UploadBytesReceived = promauto.NewCounter(prometheus.CounterOpts{
		Namespace: namespace,
		Name:      "upload_bytes_received_total",
		Help:      "Bytes committed to a tus upload.",
	})

	// Uploads counts finished uploads by outcome.
	//
	// PromQL: sum by (outcome) (rate(ss_uploads_total[15m]))
	Uploads = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace,
		Name:      "uploads_total",
		Help:      "tus uploads that ended, by outcome (completed, terminated).",
	}, []string{"outcome"})
)

// Outcomes of a tus upload.
const (
	// UploadCompleted is an upload whose bytes all arrived.
	UploadCompleted = "completed"
	// UploadTerminated is an upload abandoned or reclaimed before that.
	UploadTerminated = "terminated"
)

// Torrents.
var (
	// TorrentBytesDownloaded counts bytes the bridge handed the ingest and
	// the tus store confirmed. It is the download bandwidth of a magnet room.
	//
	// PromQL: sum(rate(ss_torrent_bytes_downloaded_total[5m]))
	TorrentBytesDownloaded = promauto.NewCounter(prometheus.CounterOpts{
		Namespace: namespace,
		Name:      "torrent_bytes_downloaded_total",
		Help:      "Torrent bytes pulled in by the server-side ingest.",
	})

	// TorrentIngestsActive is how many torrents are downloading right now.
	//
	// PromQL: ss_torrent_ingests_active
	TorrentIngestsActive = promauto.NewGauge(prometheus.GaugeOpts{
		Namespace: namespace,
		Name:      "torrent_ingests_active",
		Help:      "Torrent ingests currently running.",
	})

	// TorrentIngests counts finished ingests by outcome.
	//
	// PromQL: sum by (outcome) (rate(ss_torrent_ingests_total[15m]))
	TorrentIngests = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace,
		Name:      "torrent_ingests_total",
		Help:      "Torrent ingests that ended, by outcome (completed, failed, canceled).",
	}, []string{"outcome"})

	// TorrentPeers is the swarm across every running ingest, summed rather
	// than labelled per room: a room id is unbounded, and the number worth
	// watching is whether the swarm is there at all.
	//
	// PromQL: ss_torrent_peers
	TorrentPeers = promauto.NewGauge(prometheus.GaugeOpts{
		Namespace: namespace,
		Name:      "torrent_peers",
		Help:      "Peers connected across every running torrent ingest.",
	})
)

// Outcomes of a torrent ingest.
const (
	// IngestCompleted is a torrent whose selected file arrived whole.
	IngestCompleted = "completed"
	// IngestFailed is one that gave up.
	IngestFailed = "failed"
	// IngestCanceled is one stopped by a source swap or a shutdown.
	IngestCanceled = "canceled"
)

// FFmpeg pipelines.
//
// The two pipelines are labelled rather than split into separate metrics:
// they answer the same question at different points of a room's life, and a
// dashboard almost always wants them next to each other.
var (
	// FFmpegJobsQueued is how many jobs are waiting for a worker.
	//
	// PromQL: sum by (pipeline) (ss_ffmpeg_jobs_queued)
	FFmpegJobsQueued = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Namespace: namespace,
		Name:      "ffmpeg_jobs_queued",
		Help:      "Media jobs waiting for a worker, by pipeline.",
	}, []string{"pipeline"})

	// FFmpegJobsRunning is how many workers are busy. Against FFMPEG_JOBS it
	// is the saturation of the pipeline.
	//
	// PromQL: sum by (pipeline) (ss_ffmpeg_jobs_running)
	FFmpegJobsRunning = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Namespace: namespace,
		Name:      "ffmpeg_jobs_running",
		Help:      "Media jobs currently running, by pipeline.",
	}, []string{"pipeline"})

	// FFmpegJobs counts finished jobs by outcome, including the ones the
	// queue refused outright because it was full.
	//
	// PromQL: sum by (pipeline, outcome) (rate(ss_ffmpeg_jobs_total[15m]))
	FFmpegJobs = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace,
		Name:      "ffmpeg_jobs_total",
		Help:      "Media jobs that ended, by pipeline and outcome.",
	}, []string{"pipeline", "outcome"})

	// FFmpegJobDuration measures a whole job, not just the ffmpeg process:
	// the probe, the encode and the publishing that goes with it.
	//
	// PromQL: histogram_quantile(0.9, sum by (le, pipeline) (rate(ss_ffmpeg_job_duration_seconds_bucket[30m])))
	FFmpegJobDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Namespace: namespace,
		Name:      "ffmpeg_job_duration_seconds",
		Help:      "Time a media job took, by pipeline and outcome.",
		Buckets:   jobBuckets,
	}, []string{"pipeline", "outcome"})

	// PreviewReadyDuration is the wait a viewer feels: from the moment a
	// preview job picks a room up to the moment that room can play.
	//
	// PromQL: histogram_quantile(0.9, sum by (le) (rate(ss_media_preview_ready_seconds_bucket[30m])))
	PreviewReadyDuration = promauto.NewHistogram(prometheus.HistogramOpts{
		Namespace: namespace,
		Name:      "media_preview_ready_seconds",
		Help:      "Time from a preview job starting to the room becoming playable.",
		Buckets:   previewBuckets,
	})

	// VideoHandling counts how each job treated the video track. Copying is
	// nearly free and transcoding is not, so the ratio between the two is the
	// single best predictor of what the machine is about to spend.
	//
	// PromQL: sum by (mode) (rate(ss_media_video_handling_total[1h]))
	VideoHandling = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace,
		Name:      "media_video_handling_total",
		Help:      "Media jobs by how the video track was handled, by pipeline.",
	}, []string{"pipeline", "mode"})
)

// Media pipelines.
const (
	// PipelineFinal is the authoritative remux of a completed source.
	PipelineFinal = "final"
	// PipelinePreview is the progressive pass over a still-growing source.
	PipelinePreview = "preview"
)

// Outcomes of a media job.
const (
	// JobSucceeded is a job that published its media.
	JobSucceeded = "succeeded"
	// JobFailed is a job that gave up on a source it could not process.
	JobFailed = "failed"
	// JobCanceled is a job stopped by a source swap or a shutdown.
	JobCanceled = "canceled"
	// JobRejected is a job the queue refused because it was already full.
	JobRejected = "rejected"
)

// How a job treated the video track.
const (
	// VideoCopied is a passthrough: the source codec is playable as it is.
	VideoCopied = "copy"
	// VideoTranscoded is a re-encode, which is what actually costs CPU.
	VideoTranscoded = "transcode"
)

// Object storage.
//
// The billing class is a label rather than two separate metrics because it
// is exactly what the invoice is grouped by, and R2 prices the two classes
// more than an order of magnitude apart. Which operation falls in which
// class comes from Cloudflare's own pricing page; see classify in the
// objectstore package.
var (
	// ObjectStoreOperations counts requests that reached the bucket, by the
	// S3 operation they were and by what R2 bills them as.
	//
	// PromQL: sum by (class) (rate(ss_objectstore_operations_total[5m]))
	ObjectStoreOperations = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace,
		Name:      "objectstore_operations_total",
		Help:      "Object storage requests, by S3 operation and R2 billing class.",
	}, []string{"operation", "class"})

	// ObjectStoreDuration measures one request to the bucket.
	//
	// PromQL: histogram_quantile(0.95, sum by (le, operation) (rate(ss_objectstore_operation_duration_seconds_bucket[5m])))
	ObjectStoreDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Namespace: namespace,
		Name:      "objectstore_operation_duration_seconds",
		Help:      "Time one object storage request took, by S3 operation.",
		Buckets:   storeBuckets,
	}, []string{"operation"})

	// ObjectStoreErrors counts requests that did not come back with a usable
	// answer, split by whether the transport failed or the bucket refused.
	//
	// PromQL: sum by (operation) (rate(ss_objectstore_errors_total[5m]))
	ObjectStoreErrors = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace,
		Name:      "objectstore_errors_total",
		Help:      "Failed object storage requests, by S3 operation and kind of failure.",
	}, []string{"operation", "kind"})

	// ObjectStoreBytesWritten counts what was handed to the bucket. Egress
	// out of R2 is free and does not pass through here; this is the write
	// side, which is what the storage line of the bill accumulates from.
	//
	// PromQL: sum(rate(ss_objectstore_bytes_written_total[5m]))
	ObjectStoreBytesWritten = promauto.NewCounter(prometheus.CounterOpts{
		Namespace: namespace,
		Name:      "objectstore_bytes_written_total",
		Help:      "Bytes uploaded to object storage.",
	})
)

// R2 billing classes, priced per million requests and more than ten times
// apart, which is why they are worth telling apart at all.
const (
	// ClassA is the expensive class: writes, listings and every multipart
	// part.
	ClassA = "class_a"
	// ClassB is the cheap class: reads and metadata.
	ClassB = "class_b"
	// ClassFree is what R2 does not bill: deletes and aborted multiparts.
	ClassFree = "free"
	// ClassUnknown is an operation Cloudflare's pricing page does not name.
	// It is not folded into either billed class: guessing would put figures
	// on a cost dashboard that the invoice then contradicts.
	ClassUnknown = "unknown"
)

// Kinds of object storage failure.
const (
	// ErrorTransport is a request that never got an answer.
	ErrorTransport = "transport"
	// ErrorStatus is a request the bucket answered with a 4xx or 5xx.
	ErrorStatus = "status"
)

// A labelled metric has no series at all until something writes to one, which
// on a dashboard is indistinguishable from the exporter being gone: a queue
// that has never rejected a job and a server that stopped reporting both draw
// as "No data". Every label combination this package owns outright is
// therefore created at zero on startup, so an empty panel means empty and a
// missing panel means broken.
//
// The object storage metrics are deliberately left out. Their operation label
// comes from Cloudflare's catalogue rather than from a set this package
// decides, and seeding the whole of it would export dozens of series for
// operations this application never performs.
func init() {
	for _, pipeline := range []string{PipelineFinal, PipelinePreview} {
		FFmpegJobsQueued.WithLabelValues(pipeline)
		FFmpegJobsRunning.WithLabelValues(pipeline)
		for _, outcome := range []string{JobSucceeded, JobFailed, JobCanceled, JobRejected} {
			FFmpegJobs.WithLabelValues(pipeline, outcome)
		}
		for _, mode := range []string{VideoCopied, VideoTranscoded} {
			VideoHandling.WithLabelValues(pipeline, mode)
		}
	}
	for _, outcome := range []string{UploadCompleted, UploadTerminated} {
		Uploads.WithLabelValues(outcome)
	}
	for _, outcome := range []string{IngestCompleted, IngestFailed, IngestCanceled} {
		TorrentIngests.WithLabelValues(outcome)
	}
	for _, outcome := range []string{JoinAccepted, JoinRejected} {
		ParticipantJoins.WithLabelValues(outcome)
	}
	for _, reason := range []string{ReclaimIdle, ReclaimExpired} {
		RoomsReclaimed.WithLabelValues(reason)
	}
	for _, direction := range []string{"in", "out"} {
		WebsocketMessages.WithLabelValues(direction, "other")
	}
}

package worker

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/remux"
	"github.com/giulianoo0/ss/internal/room"
)

// The remote-remux orchestrator: one intention per room, one run at a time,
// the claim held by the backend on the room's behalf. The browser asks to
// start and then may leave; seeks follow the room's authoritative position;
// heartbeats carry run state back and renew what a live run needs.

var (
	ErrRemuxDisabled    = errors.New("remux_disabled")
	ErrRemuxUnavailable = errors.New("remux_unavailable")
	ErrRemuxConflict    = errors.New("remux_conflict")
	ErrRemuxDenied      = errors.New("remux_denied")
	ErrRemuxRoomState   = errors.New("remux_room_state")
)

// RemuxRun is the durable record of a room's remote production.
type RemuxRun struct {
	RunID           string    `json:"runId"`
	RequestID       string    `json:"requestId"`
	JobID           string    `json:"jobId"`
	SessionID       string    `json:"sessionId"`
	WorkerID        string    `json:"workerId"`
	Infohash        string    `json:"infohash"`
	FileIndex       int       `json:"fileIndex"`
	LeaseID         string    `json:"leaseId"`
	Claim           string    `json:"claim"`
	RoomID          string    `json:"roomId"`
	MediaGeneration int       `json:"mediaGeneration"`
	Region          int       `json:"region"`
	StartMs         int64     `json:"startMs"`
	State           string    `json:"state"`
	ProducedMs      int64     `json:"producedMs"`
	UpdatedAt       time.Time `json:"updatedAt"`
}

func remuxRunKey(roomID string) string { return "room:" + roomID + ":remux" }

// RemuxOrchestrator drives remote runs. All state that must survive a
// restart lives in Redis; the in-memory locks only serialize this process.
type RemuxOrchestrator struct {
	Service *Service
	Store   *room.Store
	Cfg     config.Config
	// Notify tells a room's members it changed; the hub supplies it.
	Notify func(roomID string)

	mu      sync.Mutex
	byRoom  map[string]*sync.Mutex
	follows map[string]time.Time
}

func NewRemuxOrchestrator(service *Service, store *room.Store, cfg config.Config) *RemuxOrchestrator {
	return &RemuxOrchestrator{
		Service: service,
		Store:   store,
		Cfg:     cfg,
		byRoom:  map[string]*sync.Mutex{},
		follows: map[string]time.Time{},
	}
}

func (o *RemuxOrchestrator) roomLock(roomID string) *sync.Mutex {
	o.mu.Lock()
	defer o.mu.Unlock()
	lock, ok := o.byRoom[roomID]
	if !ok {
		lock = &sync.Mutex{}
		o.byRoom[roomID] = lock
	}
	return lock
}

func (o *RemuxOrchestrator) rdb() *redis.Client { return o.Service.Registry.rdb }

func (o *RemuxOrchestrator) saveRun(ctx context.Context, run *RemuxRun) error {
	raw, err := json.Marshal(run)
	if err != nil {
		return err
	}
	return o.rdb().Set(ctx, remuxRunKey(run.RoomID), raw, time.Duration(o.Cfg.RoomTTLHours)*time.Hour).Err()
}

// LoadRun answers the room's remux record, nil when there is none.
func (o *RemuxOrchestrator) LoadRun(ctx context.Context, roomID string) (*RemuxRun, error) {
	raw, err := o.rdb().Get(ctx, remuxRunKey(roomID)).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var run RemuxRun
	if err := json.Unmarshal(raw, &run); err != nil {
		return nil, err
	}
	return &run, nil
}

func (o *RemuxOrchestrator) deleteRun(ctx context.Context, roomID string) {
	_ = o.rdb().Del(ctx, remuxRunKey(roomID)).Err()
}

// capableWorker says whether this job's worker can take a remux run now.
func (o *RemuxOrchestrator) capableWorker(workerID string) bool {
	held, ok := o.Service.Registry.Get(workerID)
	if !ok || !held.Healthy(time.Now()) {
		return false
	}
	capability := held.Heartbeat.Remux
	return capability.Compatible() && capability.ActiveRuns < capability.Slots
}

// Start reserves the room's producer claim and dispatches the first run.
// Authorization is one of two modes: the room's ownerToken (bootstrap,
// before the host's socket exists) or a connected controller's capability,
// verified by the authorize callback the HTTP layer supplies. Both require
// the session that owns the torrent job.
func (o *RemuxOrchestrator) Start(ctx context.Context, sessionID, jobID string, req remux.StartRequest,
	authorizeMember func(memberID, capability string) bool) (*remux.StartResponse, error) {
	if !o.Cfg.RemoteRemuxEnabled {
		return nil, ErrRemuxDisabled
	}
	job, err := o.Service.Get(ctx, sessionID, jobID)
	if err != nil {
		return nil, err
	}
	if job.State != JobServing || job.FileIndex == nil {
		return nil, ErrNotListed
	}
	storedRoom, err := o.Store.Get(ctx, req.RoomID)
	if errors.Is(err, room.ErrNotFound) {
		return nil, ErrRemuxRoomState
	}
	if err != nil {
		return nil, err
	}
	if !storedRoom.ExpiresAt.After(time.Now()) || storedRoom.MediaGeneration != req.MediaGeneration ||
		storedRoom.Status != "uploading" {
		return nil, ErrRemuxRoomState
	}
	switch {
	case req.Auth.OwnerToken != "":
		if subtle.ConstantTimeCompare([]byte(req.Auth.OwnerToken), []byte(storedRoom.OwnerToken)) != 1 ||
			storedRoom.OwnerToken == "" {
			return nil, ErrRemuxDenied
		}
	case req.Auth.MemberID != "" && req.Auth.Capability != "":
		if authorizeMember == nil || !authorizeMember(req.Auth.MemberID, req.Auth.Capability) ||
			storedRoom.ControllerID != req.Auth.MemberID {
			return nil, ErrRemuxDenied
		}
	default:
		return nil, ErrRemuxDenied
	}

	lock := o.roomLock(req.RoomID)
	lock.Lock()
	defer lock.Unlock()

	if existing, err := o.LoadRun(ctx, req.RoomID); err == nil && existing != nil {
		// One production per room and generation: the same request replays
		// its receipt, a different one while a run lives is deduplicated
		// onto it rather than doubling FFmpeg.
		if existing.MediaGeneration == req.MediaGeneration && !remux.TerminalState(existing.State) {
			return &remux.StartResponse{Remote: true, RunID: existing.RunID,
				MediaGeneration: existing.MediaGeneration, State: existing.State}, nil
		}
		if existing.MediaGeneration != req.MediaGeneration {
			o.deleteRun(ctx, req.RoomID)
		} else if existing.RequestID == req.RequestID {
			return &remux.StartResponse{Remote: true, RunID: existing.RunID,
				MediaGeneration: existing.MediaGeneration, State: existing.State}, nil
		}
	}

	if !o.capableWorker(job.WorkerID) {
		return nil, ErrRemuxUnavailable
	}

	secret := make([]byte, 16)
	if _, err := rand.Read(secret); err != nil {
		return nil, err
	}
	claim := "client:" + hex.EncodeToString(secret)
	if err := o.Store.ReserveUpload(ctx, req.RoomID, claim, time.Now()); err != nil {
		if errors.Is(err, room.ErrUploadReserved) {
			return nil, ErrRemuxConflict
		}
		return nil, ErrRemuxRoomState
	}

	run := &RemuxRun{
		RunID:           "run_" + randomID(8),
		RequestID:       req.RequestID,
		JobID:           job.ID,
		SessionID:       sessionID,
		WorkerID:        job.WorkerID,
		Infohash:        job.Infohash,
		FileIndex:       *job.FileIndex,
		LeaseID:         job.LeaseID,
		Claim:           claim,
		RoomID:          req.RoomID,
		MediaGeneration: req.MediaGeneration,
		Region:          0,
		StartMs:         req.StartMs,
		State:           remux.RunStarting,
		UpdatedAt:       time.Now(),
	}
	// Intention before dispatch: a crash between the two leaves a record to
	// reconcile, never a process nobody owns.
	if err := o.saveRun(ctx, run); err != nil {
		_ = o.Store.ReleaseUpload(ctx, req.RoomID, claim)
		return nil, err
	}
	// The fence is set here, not by the first publish: a claim minted for
	// this run must not be usable by anything else.
	if err := o.Store.SetProducerRun(ctx, req.RoomID, run.RunID); err != nil {
		slog.WarnContext(ctx, "set producer run failed", "room_id", req.RoomID, "error", err)
	}
	if err := o.dispatchStart(ctx, run); err != nil {
		o.deleteRun(ctx, req.RoomID)
		_ = o.Store.ReleaseUpload(ctx, req.RoomID, claim)
		return nil, err
	}
	run.State = remux.RunAccepted
	run.UpdatedAt = time.Now()
	_ = o.saveRun(ctx, run)
	return &remux.StartResponse{Remote: true, RunID: run.RunID,
		MediaGeneration: run.MediaGeneration, State: run.State}, nil
}

func (o *RemuxOrchestrator) dispatchStart(ctx context.Context, run *RemuxRun) error {
	spec := remux.Spec{
		ProtocolVersion: remux.ProtocolVersion,
		RunID:           run.RunID,
		Claim:           run.Claim,
		MediaGeneration: run.MediaGeneration,
		Region:          run.Region,
		StartMs:         run.StartMs,
		APIBase:         o.Cfg.RemoteRemuxAPIBase,
		RoomID:          run.RoomID,
		Limits: remux.Limits{
			PutConcurrency: 4,
		},
	}
	index := run.FileIndex
	result, err := o.Service.Hub.Dispatch(ctx, Job{
		Kind:      "remuxStart",
		JobID:     "rx_" + randomID(6),
		WorkerID:  run.WorkerID,
		Infohash:  run.Infohash,
		FileIndex: &index,
		RoomID:    run.RoomID,
		LeaseID:   run.LeaseID,
		Remux:     spec,
	}, 60*time.Second)
	if err != nil {
		return fmt.Errorf("remux dispatch: %w", err)
	}
	if !result.OK {
		return fmt.Errorf("remux refused: %s", result.Error)
	}
	return nil
}

func (o *RemuxOrchestrator) dispatchCancel(run *RemuxRun) {
	_ = o.Service.Hub.Send(Job{
		Kind:     "remuxCancel",
		JobID:    "rc_" + randomID(6),
		WorkerID: run.WorkerID,
		Infohash: run.Infohash,
		Remux:    map[string]string{"runId": run.RunID},
	})
}

// followSlack is how far past a region's produced edge a position may point
// and still count as covered: production is heading there.
const followAheadMs = 45_000
const followBehindMs = 1_500
const followDebounce = 3 * time.Second

// Follow tracks the room's authoritative position. Covered positions do
// nothing; an uncovered one replaces the run at the target. Buffer reports
// never reach here — only controller state changes do.
func (o *RemuxOrchestrator) Follow(roomID string, positionMs int64) {
	if !o.Cfg.RemoteRemuxEnabled || positionMs < 0 {
		return
	}
	o.mu.Lock()
	last := o.follows[roomID]
	if time.Since(last) < followDebounce {
		o.mu.Unlock()
		return
	}
	o.follows[roomID] = time.Now()
	o.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	lock := o.roomLock(roomID)
	lock.Lock()
	defer lock.Unlock()

	run, err := o.LoadRun(ctx, roomID)
	if err != nil || run == nil || remux.TerminalState(run.State) {
		return
	}
	storedRoom, err := o.Store.Get(ctx, roomID)
	if err != nil || !storedRoom.ExpiresAt.After(time.Now()) ||
		storedRoom.MediaGeneration != run.MediaGeneration {
		return
	}
	if coveredByRegions(storedRoom.MediaRegions, run, positionMs) {
		return
	}
	replaced := *run
	replaced.RunID = "run_" + randomID(8)
	replaced.Region = highestRegion(storedRoom.MediaRegions, run.Region) + 1
	replaced.StartMs = positionMs
	replaced.State = remux.RunStarting
	replaced.UpdatedAt = time.Now()
	// Reserve the new run and revoke the old atomically enough: the fence
	// moves first, so the old committer's next publish is refused before
	// the old process is even told to stop.
	if err := o.Store.SetProducerRun(ctx, roomID, replaced.RunID); err != nil {
		return
	}
	if err := o.saveRun(ctx, &replaced); err != nil {
		return
	}
	o.dispatchCancel(run)
	// The worker may still be winding the old run down when the new start
	// lands; a busy slot deserves a couple of beats, not a dead cold seek.
	startErr := o.dispatchStart(ctx, &replaced)
	for tries := 0; startErr != nil && strings.Contains(startErr.Error(), "remux_busy") && tries < 3; tries++ {
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
		startErr = o.dispatchStart(ctx, &replaced)
	}
	if startErr != nil {
		slog.Warn("remux follow dispatch failed", "room_id", roomID, "error", startErr)
		replaced.State = remux.RunFailed
		replaced.UpdatedAt = time.Now()
		_ = o.saveRun(ctx, &replaced)
	} else {
		replaced.State = remux.RunAccepted
		replaced.UpdatedAt = time.Now()
		_ = o.saveRun(ctx, &replaced)
	}
}

func coveredByRegions(regions []room.MediaRegion, run *RemuxRun, positionMs int64) bool {
	for _, region := range regions {
		end := region.StartMs + region.ProducedMs
		forward := end
		if region.Growing || region.N == run.Region {
			forward = maxInt64(end, run.StartMs+run.ProducedMs) + followAheadMs
		}
		if positionMs >= region.StartMs-followBehindMs && positionMs <= forward {
			return true
		}
	}
	// A run that has not confirmed anything yet still covers its own aim.
	if len(regions) == 0 || run.State == remux.RunStarting || run.State == remux.RunAccepted {
		aim := run.StartMs
		if positionMs >= aim-followBehindMs && positionMs <= aim+run.ProducedMs+followAheadMs {
			return true
		}
	}
	return false
}

func highestRegion(regions []room.MediaRegion, floor int) int {
	top := floor
	for _, region := range regions {
		if region.N > top {
			top = region.N
		}
	}
	return top
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

// CancelRoom ends the room's remote production: source swap, reclaim, or
// the room dying. The claim goes with it.
func (o *RemuxOrchestrator) CancelRoom(roomID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	lock := o.roomLock(roomID)
	lock.Lock()
	defer lock.Unlock()
	run, err := o.LoadRun(ctx, roomID)
	if err != nil || run == nil {
		return
	}
	o.dispatchCancel(run)
	_ = o.Store.ReleaseUpload(ctx, roomID, run.Claim)
	o.deleteRun(ctx, roomID)
}

// ObserveHeartbeat digests a worker's remux block: run states move the
// records, live runs renew the lease and the claim, and terminal runs
// settle the room.
func (o *RemuxOrchestrator) ObserveHeartbeat(workerID string, hb Heartbeat) {
	if hb.Remux == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ids, err := o.Service.Registry.JobsForWorker(ctx, workerID)
	if err != nil {
		return
	}
	rooms := map[string]struct{}{}
	for _, id := range ids {
		job, err := o.Service.Registry.LoadJob(ctx, id)
		if err != nil || job == nil || job.RoomID == "" {
			continue
		}
		rooms[job.RoomID] = struct{}{}
	}
	for roomID := range rooms {
		run, err := o.LoadRun(ctx, roomID)
		if err != nil || run == nil || run.WorkerID != workerID {
			continue
		}
		report := findRun(hb.Remux.Runs, run.RunID)
		if report == nil {
			// The worker no longer knows this run — it restarted, or pruned a
			// terminal run before a heartbeat carried it. A short grace covers
			// the dispatch-to-first-heartbeat window; past it the run is lost,
			// and lost is failed, not silently stuck.
			if !remux.TerminalState(run.State) && time.Since(run.UpdatedAt) > 45*time.Second {
				o.applyReport(ctx, run, &remux.RunReport{
					RunID: run.RunID, State: remux.RunFailed, Error: "run lost by the worker",
				})
			}
			continue
		}
		o.applyReport(ctx, run, report)
	}
}

func findRun(runs []remux.RunReport, runID string) *remux.RunReport {
	for i := range runs {
		if runs[i].RunID == runID {
			return &runs[i]
		}
	}
	return nil
}

func (o *RemuxOrchestrator) applyReport(ctx context.Context, run *RemuxRun, report *remux.RunReport) {
	lock := o.roomLock(run.RoomID)
	lock.Lock()
	defer lock.Unlock()
	current, err := o.LoadRun(ctx, run.RoomID)
	if err != nil || current == nil || current.RunID != run.RunID {
		return
	}
	current.State = report.State
	current.ProducedMs = report.ProducedMs
	current.UpdatedAt = time.Now()
	switch report.State {
	case remux.RunCompleted:
		// The worker's complete publish released the claim already; the
		// record stays as the receipt until the room moves on. A run that
		// began at zero covered the whole timeline: the bucket is the copy
		// now, so the torrent goes at once instead of idling until the
		// sweep — the worker reaps the file and the disk comes back.
		_ = o.saveRun(ctx, current)
		if current.StartMs == 0 {
			if job, err := o.Service.Registry.LoadJob(ctx, current.JobID); err == nil && job != nil {
				o.Service.release(ctx, job)
			}
			// The job's heartbeats die with it, so the room's last swarm
			// numbers would freeze mid-download forever: settle them at
			// "everything arrived, nothing moving" and tell the members.
			if storedRoom, err := o.Store.Get(ctx, run.RoomID); err == nil {
				size := storedRoom.Preparation.SourceBytes
				_ = o.Store.SetSwarm(ctx, run.RoomID, room.SwarmStats{
					HaveBytes: size, SelectedBytes: size,
				})
				// The covering run walked the whole source, so what it produced
				// is all the video there will ever be. A container that promises
				// more — an audio stream running past the video's end — leaves
				// every player waiting at a tail no run can produce.
				if current.ProducedMs > 0 && current.ProducedMs < storedRoom.DurationMs {
					slog.Info("covering run ended short of the container duration; clamping",
						"room_id", run.RoomID, "produced_ms", current.ProducedMs, "duration_ms", storedRoom.DurationMs)
					_ = o.Store.SetMediaDuration(ctx, run.RoomID, current.ProducedMs)
				}
				if o.Notify != nil {
					o.Notify(run.RoomID)
				}
			}
		}
	case remux.RunFailed:
		slog.Warn("remote remux failed", "room_id", run.RoomID, "run", run.RunID, "error", report.Error)
		_ = o.Store.ReleaseUpload(ctx, run.RoomID, current.Claim)
		if storedRoom, err := o.Store.Get(ctx, run.RoomID); err == nil && storedRoom.Status == "uploading" {
			_ = o.Store.SetError(ctx, run.RoomID, "remote remux failed")
		}
		_ = o.saveRun(ctx, current)
	default:
		_ = o.saveRun(ctx, current)
		// A live run is its own heartbeat: the claim and the lease stay
		// renewed for as long as the worker keeps reporting it.
		_ = o.Store.TouchClientClaim(ctx, run.RoomID)
		if job, err := o.Service.Registry.LoadJob(ctx, run.JobID); err == nil && job != nil {
			job.LastSeenAt = time.Now()
			_ = o.Service.Registry.SaveJob(ctx, job, o.Service.JobTTL)
			_ = o.Service.Hub.Send(Job{Kind: "renew", JobID: "n_" + randomID(6),
				WorkerID: job.WorkerID, Infohash: job.Infohash, LeaseID: job.LeaseID})
		}
	}
}

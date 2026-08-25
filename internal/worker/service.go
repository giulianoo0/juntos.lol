package worker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"
)

// Service is what the HTTP layer and the room lifecycle call: the debrid
// state machine — register by infohash, list, select, get bytes — with the
// fleet behind it.
type Service struct {
	Registry  *Registry
	Hub       *Hub
	Signer    *Signer
	Blocklist *Blocklist
	// Quota charges sessions; nil-safe.
	Quota QuotaCharger
	// TicketTTL bounds a data-plane ticket.
	TicketTTL time.Duration
	// JobTTL bounds a job record that nobody touches.
	JobTTL time.Duration
}

// QuotaCharger is the slice of the quota the service needs.
type QuotaCharger interface {
	AcquireJob(ctx context.Context, sid, jobID string, ttl time.Duration) (bool, error)
	ReleaseJob(ctx context.Context, sid, jobID string) error
	AddBytes(ctx context.Context, sid string, n int64) error
}

// Errors the HTTP layer maps to codes.
var (
	ErrBlocked     = errors.New("blocked")
	ErrQuotaJobs   = errors.New("concurrent_jobs")
	ErrJobNotFound = errors.New("job_not_found")
	ErrNotYours    = errors.New("not_your_job")
	ErrNotListed   = errors.New("not_listed")
	ErrDisabled    = errors.New("no_workers")
)

// WorkerError carries a worker's own rejection code.
type WorkerError struct {
	Code   string
	Detail string
}

func (e *WorkerError) Error() string { return e.Code + ": " + e.Detail }

// Capacity is what the UI reads to enable or disable the magnet path.
func (s *Service) Capacity() string {
	if s.Hub == nil || !s.Hub.Enabled() {
		return "disabled"
	}
	now := time.Now()
	any, room := false, false
	for _, w := range s.Registry.Snapshot() {
		if !w.Healthy(now) {
			continue
		}
		any = true
		if hasRoom(w, 0) {
			room = true
		}
	}
	switch {
	case room:
		return "available"
	case any:
		return "busy"
	default:
		return "no_workers"
	}
}

// Start registers an infohash for a session: blocklist, quota, placement,
// then the lease job in the background. Returns as soon as the job is
// placed; the listing arrives through Get.
func (s *Service) Start(ctx context.Context, sessionID, infohash, name string, trackers []string) (*JobRecord, error) {
	if s.Blocklist.Rejects(infohash, name) {
		return nil, ErrBlocked
	}
	if s.Hub == nil || !s.Hub.Enabled() {
		return nil, ErrDisabled
	}
	worker, err := s.Registry.Place(infohash, 0, time.Now())
	if err != nil {
		return nil, err
	}
	job := &JobRecord{
		ID:         "j_" + randomID(8),
		SessionID:  sessionID,
		Infohash:   infohash,
		WorkerID:   worker.ID,
		LeaseID:    "l_" + randomID(8),
		State:      JobResolving,
		CreatedAt:  time.Now(),
		LastSeenAt: time.Now(),
	}
	if s.Quota != nil {
		ok, err := s.Quota.AcquireJob(ctx, sessionID, job.ID, s.JobTTL)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, ErrQuotaJobs
		}
	}
	if err := s.Registry.SaveJob(ctx, job, s.JobTTL); err != nil {
		if s.Quota != nil {
			_ = s.Quota.ReleaseJob(ctx, sessionID, job.ID)
		}
		return nil, err
	}
	go s.resolve(*job, trackers)
	return job, nil
}

func (s *Service) resolve(job JobRecord, trackers []string) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	result, err := s.Hub.Dispatch(ctx, Job{
		Kind:     "lease",
		JobID:    job.ID,
		WorkerID: job.WorkerID,
		Infohash: job.Infohash,
		LeaseID:  job.LeaseID,
		Trackers: trackers,
	}, 3*time.Minute)
	current, loadErr := s.Registry.LoadJob(ctx, job.ID)
	if loadErr != nil || current == nil {
		return
	}
	switch {
	case err != nil:
		// The worker may well have finished the lease and be holding the
		// torrent; nothing here will read it, so it is released.
		current.State, current.Error = JobFailed, mapDispatchError(err)
		_ = s.Hub.Send(Job{Kind: "release", JobID: "r_" + randomID(6), WorkerID: job.WorkerID, Infohash: job.Infohash, LeaseID: job.LeaseID})
	case !result.OK:
		current.State, current.Error = JobFailed, result.Error
		if result.Detail != "" {
			slog.Info("worker refused lease", "job", job.ID, "code", result.Error, "detail", result.Detail)
		}
	default:
		// The name is only known now; the blocklist gets its second look.
		if s.Blocklist.Rejects(current.Infohash, result.Name) {
			current.State, current.Error = JobFailed, ErrBlocked.Error()
			_ = s.Hub.Send(Job{Kind: "release", JobID: "r_" + randomID(6), WorkerID: job.WorkerID, Infohash: job.Infohash, LeaseID: job.LeaseID})
		} else {
			current.State, current.Name, current.Files = JobListed, result.Name, result.Files
		}
	}
	if current.State == JobFailed && s.Quota != nil {
		_ = s.Quota.ReleaseJob(ctx, current.SessionID, current.ID)
	}
	_ = s.Registry.SaveJob(ctx, current, s.JobTTL)
}

func mapDispatchError(err error) string {
	switch {
	case errors.Is(err, ErrWorkerGone):
		return "worker_gone"
	case errors.Is(err, context.DeadlineExceeded):
		return "worker_timeout"
	default:
		return err.Error()
	}
}

// Get answers a job the session owns. Polling is a sign of life: a job
// still being watched is not idle.
func (s *Service) Get(ctx context.Context, sessionID, jobID string) (*JobRecord, error) {
	job, err := s.Registry.LoadJob(ctx, jobID)
	if err != nil {
		return nil, err
	}
	if job == nil {
		return nil, ErrJobNotFound
	}
	if job.SessionID != sessionID {
		return nil, ErrNotYours
	}
	if time.Since(job.LastSeenAt) > 30*time.Second {
		job.LastSeenAt = time.Now()
		_ = s.Registry.SaveJob(ctx, job, s.JobTTL)
	}
	return job, nil
}

// SwarmStats is the slice of a heartbeat a viewer cares about.
type SwarmStats struct {
	Peers         int64  `json:"peers"`
	DownSpeed     int64  `json:"downSpeed"`
	HaveBytes     int64  `json:"haveBytes"`
	SelectedBytes int64  `json:"selectedBytes"`
	Phase         string `json:"phase,omitempty"`
}

// Swarm answers the job's torrent as its worker last reported it.
func (s *Service) Swarm(job *JobRecord) *SwarmStats {
	d, ok := s.Registry.Digest(job.WorkerID, job.Infohash)
	if !ok {
		return nil
	}
	return &SwarmStats{Peers: d.Peers, DownSpeed: d.DownSpeed, HaveBytes: d.HaveBytes, SelectedBytes: d.SelectedBytes, Phase: d.Phase}
}

// Grant is what a selected file can be read with.
type Grant struct {
	ReadBase  string    `json:"readBase"`
	Ticket    string    `json:"ticket"`
	ExpiresAt time.Time `json:"expiresAt"`
	Name      string    `json:"name"`
	Size      int64     `json:"size"`
	FileIndex int       `json:"fileIndex"`
}

// Select makes the worker download one file and mints the first ticket.
func (s *Service) Select(ctx context.Context, sessionID, jobID string, fileIndex int, roomID, audience string) (*Grant, error) {
	job, err := s.Get(ctx, sessionID, jobID)
	if err != nil {
		return nil, err
	}
	if job.State != JobListed && job.State != JobServing && job.State != JobSelecting {
		return nil, ErrNotListed
	}
	var file *FileEntry
	for i := range job.Files {
		if job.Files[i].Index == fileIndex {
			file = &job.Files[i]
		}
	}
	if file == nil {
		return nil, &WorkerError{Code: "no_such_file", Detail: fmt.Sprintf("index %d", fileIndex)}
	}
	job.State, job.FileIndex, job.RoomID, job.Audience, job.LastSeenAt = JobSelecting, &fileIndex, roomID, audience, time.Now()
	_ = s.Registry.SaveJob(ctx, job, s.JobTTL)
	result, err := s.Hub.Dispatch(ctx, Job{
		Kind:      "select",
		JobID:     "s_" + randomID(6),
		WorkerID:  job.WorkerID,
		Infohash:  job.Infohash,
		FileIndex: &fileIndex,
		RoomID:    roomID,
	}, 60*time.Second)
	// A select that did not land leaves the job listed: the lease is alive,
	// the worker may hold the file, and the next select costs no dispatch.
	if err != nil {
		job.State, job.Error = JobListed, mapDispatchError(err)
		_ = s.Registry.SaveJob(ctx, job, s.JobTTL)
		return nil, &WorkerError{Code: job.Error, Detail: err.Error()}
	}
	if !result.OK {
		job.State, job.Error = JobListed, result.Error
		_ = s.Registry.SaveJob(ctx, job, s.JobTTL)
		return nil, &WorkerError{Code: result.Error, Detail: result.Detail}
	}
	job.State = JobServing
	_ = s.Registry.SaveJob(ctx, job, s.JobTTL)
	return s.grant(job, file)
}

func (s *Service) grant(job *JobRecord, file *FileEntry) (*Grant, error) {
	worker, ok := s.Registry.Get(job.WorkerID)
	if !ok {
		return nil, ErrWorkerGone
	}
	exp := time.Now().Add(s.TicketTTL)
	ticket, err := s.Signer.MintTicket(Ticket{
		RoomID:    job.RoomID,
		Infohash:  job.Infohash,
		FileIndex: file.Index,
		Audience:  job.Audience,
		WorkerID:  job.WorkerID,
		Exp:       exp.Unix(),
	})
	if err != nil {
		return nil, err
	}
	return &Grant{ReadBase: worker.PublicBase, Ticket: ticket, ExpiresAt: exp, Name: file.Name, Size: file.Size, FileIndex: file.Index}, nil
}

// Token renews the ticket of a serving job and tells the worker the lease
// is still wanted. A remux of a big file outlives any single ticket. The
// first renewal also names the room the job feeds, which is what lets a
// source swap or the room's end release it — after the room exists, so
// the swap that created it cannot cancel it.
func (s *Service) Token(ctx context.Context, sessionID, jobID, roomID string) (*Grant, error) {
	job, err := s.Get(ctx, sessionID, jobID)
	if err != nil {
		return nil, err
	}
	if job.State != JobServing || job.FileIndex == nil {
		return nil, ErrNotListed
	}
	if roomID != "" && job.RoomID != roomID {
		job.RoomID = roomID
	}
	var file *FileEntry
	for i := range job.Files {
		if job.Files[i].Index == *job.FileIndex {
			file = &job.Files[i]
		}
	}
	if file == nil {
		return nil, ErrNotListed
	}
	job.LastSeenAt = time.Now()
	_ = s.Registry.SaveJob(ctx, job, s.JobTTL)
	_ = s.Hub.Send(Job{Kind: "renew", JobID: "n_" + randomID(6), WorkerID: job.WorkerID, Infohash: job.Infohash, LeaseID: job.LeaseID})
	return s.grant(job, file)
}

// Release ends a job: the worker drops the lease, the session gets its slot back.
func (s *Service) Release(ctx context.Context, sessionID, jobID string) error {
	job, err := s.Get(ctx, sessionID, jobID)
	if err != nil {
		return err
	}
	s.release(ctx, job)
	return nil
}

func (s *Service) release(ctx context.Context, job *JobRecord) {
	_ = s.Hub.Send(Job{Kind: "release", JobID: "r_" + randomID(6), WorkerID: job.WorkerID, Infohash: job.Infohash, LeaseID: job.LeaseID})
	if s.Quota != nil {
		_ = s.Quota.ReleaseJob(ctx, job.SessionID, job.ID)
	}
	_ = s.Registry.DeleteJob(ctx, job)
}

// CancelRoom releases every job a room holds: the source was swapped or
// the room died, and nothing should keep a worker holding 50 GB for it.
func (s *Service) CancelRoom(roomID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ids, err := s.Registry.JobsForRoom(ctx, roomID)
	if err != nil {
		return
	}
	for _, id := range ids {
		job, err := s.Registry.LoadJob(ctx, id)
		if err != nil || job == nil {
			continue
		}
		s.release(ctx, job)
	}
}

// Sweep releases jobs nobody renewed within idle, and fails jobs whose
// worker has gone quiet.
func (s *Service) Sweep(ctx context.Context, idle time.Duration) {
	ids, err := s.Registry.AllJobs(ctx)
	if err != nil {
		return
	}
	now := time.Now()
	for _, id := range ids {
		job, err := s.Registry.LoadJob(ctx, id)
		if err != nil {
			continue
		}
		if job == nil {
			_ = s.Registry.DeleteJob(ctx, &JobRecord{ID: id})
			continue
		}
		if now.Sub(job.LastSeenAt) > idle || (job.State == JobFailed && now.Sub(job.LastSeenAt) > 10*time.Minute) {
			slog.Info("worker job idle, releasing", "job", id, "room", job.RoomID, "state", job.State)
			s.release(ctx, job)
			continue
		}
		if w, ok := s.Registry.Get(job.WorkerID); (!ok || now.Sub(w.LastSeen) > 2*time.Minute) && job.State != JobFailed {
			job.State, job.Error = JobFailed, "worker_gone"
			_ = s.Registry.SaveJob(ctx, job, s.JobTTL)
			if s.Quota != nil {
				_ = s.Quota.ReleaseJob(ctx, job.SessionID, job.ID)
			}
		}
	}
}

// Charge accounts a heartbeat's per-torrent growth to the session whose
// job sits on that torrent. It is the only byte signal there is: the
// browser never reports, and the worker's number is trusted as far as the
// fleet is. The damage a wrong number can do is bounded: growth is charged
// once per torrent per worker, never past the selected file's size, and a
// reset restarts the count instead of charging the re-download.
func (s *Service) Charge(workerID string, hb Heartbeat) {
	if s.Quota == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ids, err := s.Registry.JobsForWorker(ctx, workerID)
	if err != nil {
		return
	}
	jobs := make([]*JobRecord, 0, len(ids))
	for _, id := range ids {
		job, err := s.Registry.LoadJob(ctx, id)
		if err != nil || job == nil {
			continue
		}
		jobs = append(jobs, job)
	}
	for _, t := range hb.Torrents {
		delta := s.Registry.ChargeMark(ctx, workerID, t.Infohash, t.HaveBytes)
		if delta <= 0 {
			continue
		}
		var owner *JobRecord
		for _, job := range jobs {
			if job.Infohash == t.Infohash && (owner == nil || job.CreatedAt.Before(owner.CreatedAt)) {
				owner = job
			}
		}
		if owner == nil {
			continue
		}
		if size := selectedSize(owner); size > 0 && delta > size {
			delta = size
		}
		_ = s.Quota.AddBytes(ctx, owner.SessionID, delta)
	}
}

func selectedSize(job *JobRecord) int64 {
	if job.FileIndex == nil {
		return 0
	}
	for _, f := range job.Files {
		if f.Index == *job.FileIndex {
			return f.Size
		}
	}
	return 0
}

// StartSweeper runs Sweep on an interval until ctx ends.
func (s *Service) StartSweeper(ctx context.Context, interval, idle time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.Sweep(ctx, idle)
		}
	}
}

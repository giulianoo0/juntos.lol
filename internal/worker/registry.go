package worker

import (
	"context"
	"encoding/json"
	"log"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/giulianoo0/ss/internal/remux"
)

// Heartbeat is what a worker reports every ten seconds. The affinity table is
// derived from it on arrival and never stored.
type Heartbeat struct {
	Type       string `json:"type"`
	Version    string `json:"version"`
	UptimeSecs int64  `json:"uptimeSecs"`
	PublicBase string `json:"publicBase"`
	Ready      bool   `json:"ready"`
	Draining   bool   `json:"draining"`
	Cert       *struct {
		NotAfter   *int64  `json:"notAfter"`
		LastResult *string `json:"lastResult"`
	} `json:"cert"`
	Disk         DiskReport        `json:"disk"`
	Relayed      bool              `json:"relayed"`
	Transfer     *TransferStats    `json:"transfer"`
	Leases       int               `json:"leases"`
	MaxLeases    int               `json:"maxLeases"`
	MaxTorrents  int               `json:"maxTorrents"`
	PermitsInUse int64             `json:"permitsInUse"`
	Torrents     []TorrentDigest   `json:"torrents"`
	Remux        *remux.Capability `json:"remux,omitempty"`
}

// TransferStats is the worker's serving-bandwidth ceiling and how much of
// it the last stretch actually used.
type TransferStats struct {
	CapBps  int64 `json:"capBps"`
	UsedBps int64 `json:"usedBps"`
}

// DiskReport is a worker's storage as it last reported it. Used is what
// admission counts on — a window's worth reserved per torrent — and Real is
// what the volume actually carries; the window punches the rest back out.
type DiskReport struct {
	Used  int64 `json:"used"`
	Real  int64 `json:"real"`
	Quota int64 `json:"quota"`
}

type TorrentDigest struct {
	Infohash      string   `json:"infohash"`
	Name          string   `json:"name"`
	Phase         string   `json:"phase"`
	HaveBytes     int64    `json:"haveBytes"`
	SelectedBytes int64    `json:"selectedBytes"`
	DiskBytes     int64    `json:"diskBytes"`
	Peers         int64    `json:"peers"`
	DownSpeed     int64    `json:"downSpeed"`
	UpSpeed       int64    `json:"upSpeed"`
	UploadedBytes int64    `json:"uploadedBytes"`
	Leases        []string `json:"leases"`
	IdleSecs      int64    `json:"idleSecs"`
}

// Worker is one node's live state, kept in memory beside its link.
type Worker struct {
	ID         string
	PublicBase string
	PubKey     string
	LastSeen   time.Time
	Heartbeat  Heartbeat
	link       *link
}

// EffectiveBase is where browsers reach this worker: its own address, or
// the fleet's relay when the worker asked to stay private.
func (w *Worker) EffectiveBase(relayBase string) string {
	if w.Heartbeat.Relayed && relayBase != "" {
		return relayBase + "/relay/" + w.ID
	}
	return w.PublicBase
}

// Healthy is whether a job may be placed here right now.
func (w *Worker) Healthy(now time.Time) bool {
	return w.link != nil && now.Sub(w.LastSeen) < 35*time.Second && w.Heartbeat.Ready && !w.Heartbeat.Draining
}

func (w *Worker) Holds(infohash string) (TorrentDigest, bool) {
	for _, t := range w.Heartbeat.Torrents {
		if t.Infohash == infohash {
			return t, true
		}
	}
	return TorrentDigest{}, false
}

// Registry is liveness in memory (this instance's links) plus durable facts
// in Redis: who is enrolled, with which key, and what jobs exist.
type Registry struct {
	mu      sync.RWMutex
	workers map[string]*Worker
	rdb     *redis.Client
}

func NewRegistry(rdb *redis.Client) *Registry {
	return &Registry{workers: map[string]*Worker{}, rdb: rdb}
}

func workerKey(id string) string { return "worker:" + id }

const workersBySeen = "workers:by_seen"

func (r *Registry) Enroll(ctx context.Context, id, pubkey, publicBase string) error {
	pipe := r.rdb.TxPipeline()
	pipe.HSet(ctx, workerKey(id), "pubkey", pubkey, "publicBase", publicBase, "enrolledAt", time.Now().UTC().Format(time.RFC3339))
	pipe.ZAdd(ctx, workersBySeen, redis.Z{Score: float64(time.Now().Unix()), Member: id})
	_, err := pipe.Exec(ctx)
	return err
}

// PubKey answers an enrolled worker's key, "" when unknown.
func (r *Registry) PubKey(ctx context.Context, id string) (string, error) {
	v, err := r.rdb.HGet(ctx, workerKey(id), "pubkey").Result()
	if err == redis.Nil {
		return "", nil
	}
	return v, err
}

func (r *Registry) Attach(ctx context.Context, id, pubkey, publicBase string, l *link) {
	r.mu.Lock()
	w := r.workers[id]
	if w == nil {
		w = &Worker{ID: id}
		r.workers[id] = w
	}
	w.PubKey = pubkey
	w.PublicBase = publicBase
	w.LastSeen = time.Now()
	w.link = l
	r.mu.Unlock()
	r.rdb.HSet(ctx, workerKey(id), "publicBase", publicBase)
	r.rdb.ZAdd(ctx, workersBySeen, redis.Z{Score: float64(time.Now().Unix()), Member: id})
}

// Detach drops a link; the worker's facts stay, its liveness does not.
func (r *Registry) Detach(id string, l *link) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if w := r.workers[id]; w != nil && w.link == l {
		w.link = nil
	}
}

// Observe records a heartbeat from a link; false when that link is no
// longer the worker's current one.
func (r *Registry) Observe(ctx context.Context, id string, l *link, hb Heartbeat) bool {
	r.mu.Lock()
	w := r.workers[id]
	if w == nil || (l != nil && w.link != l) {
		r.mu.Unlock()
		return false
	}
	w.LastSeen = time.Now()
	w.Heartbeat = hb
	if hb.PublicBase != "" {
		w.PublicBase = hb.PublicBase
	}
	r.mu.Unlock()
	r.rdb.ZAdd(ctx, workersBySeen, redis.Z{Score: float64(time.Now().Unix()), Member: id})
	if hb.Cert != nil && hb.Cert.NotAfter != nil {
		r.rdb.HSet(ctx, workerKey(id), "certNotAfter", strconv.FormatInt(*hb.Cert.NotAfter, 10))
	}
	return true
}

// Cull forgets workers silent for maxAge with no live link, so a machine that
// re-enrolled under a fresh id leaves no ghost on the status page.
func (r *Registry) Cull(ctx context.Context, now time.Time, maxAge time.Duration) {
	r.mu.Lock()
	var stale []string
	for id, w := range r.workers {
		if w.link == nil && now.Sub(w.LastSeen) > maxAge {
			delete(r.workers, id)
			stale = append(stale, id)
		}
	}
	r.mu.Unlock()
	for _, id := range stale {
		r.rdb.Del(ctx, workerKey(id))
		r.rdb.ZRem(ctx, workersBySeen, id)
		log.Printf("worker %s silent for over %s; forgotten", id, maxAge)
	}
}

// ChargeMark remembers how many bytes of an infohash on a worker were
// already charged, so a heartbeat's growth is charged once, and a reset
// (the worker reaped and re-downloaded) starts a fresh count.
func (r *Registry) ChargeMark(ctx context.Context, workerID, infohash string, have int64) (delta int64) {
	key := "charged:" + workerID + ":" + infohash
	last, err := r.rdb.Get(ctx, key).Int64()
	if err != nil {
		last = 0
	}
	if have < last {
		last = 0
	}
	r.rdb.Set(ctx, key, have, 48*time.Hour)
	return have - last
}

// Get answers a copy of a worker's live state.
func (r *Registry) Get(id string) (Worker, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	w := r.workers[id]
	if w == nil {
		return Worker{}, false
	}
	return *w, true
}

// Digest answers what a worker last reported about an infohash.
func (r *Registry) Digest(workerID, infohash string) (TorrentDigest, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	w := r.workers[workerID]
	if w == nil {
		return TorrentDigest{}, false
	}
	return w.Holds(infohash)
}

// Link answers the live link to a worker, nil when it is not connected here.
func (r *Registry) Link(id string) *link {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if w := r.workers[id]; w != nil {
		return w.link
	}
	return nil
}

// Snapshot lists every worker this instance knows, most recently seen first.
func (r *Registry) Snapshot() []Worker {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Worker, 0, len(r.workers))
	for _, w := range r.workers {
		out = append(out, *w)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].LastSeen.After(out[j].LastSeen) })
	return out
}

// JobRecord is a job's durable state. Everything a browser can ask about
// lives here so any instance can answer for it.
type JobRecord struct {
	ID         string      `json:"id"`
	SessionID  string      `json:"sessionId"`
	RoomID     string      `json:"roomId,omitempty"`
	Infohash   string      `json:"infohash"`
	WorkerID   string      `json:"workerId"`
	LeaseID    string      `json:"leaseId"`
	State      string      `json:"state"`
	Error      string      `json:"error,omitempty"`
	Name       string      `json:"name,omitempty"`
	Files      []FileEntry `json:"files,omitempty"`
	FileIndex  *int        `json:"fileIndex,omitempty"`
	Audience   string      `json:"audience,omitempty"`
	CreatedAt  time.Time   `json:"createdAt"`
	LastSeenAt time.Time   `json:"lastSeenAt"`
	HaveBytes  int64       `json:"haveBytes"`
}

type FileEntry struct {
	Index int    `json:"index"`
	Name  string `json:"name"`
	Path  string `json:"path"`
	Size  int64  `json:"size"`
}

const (
	JobResolving = "resolving"
	JobListed    = "listed"
	JobSelecting = "selecting"
	JobServing   = "serving"
	JobFailed    = "failed"
	JobReleased  = "released"
)

func jobKey(id string) string          { return "job:" + id }
func workerJobsKey(id string) string   { return "worker:" + id + ":jobs" }
func roomJobsKey(roomID string) string { return "room:" + roomID + ":jobs" }

const jobsAllKey = "jobs:all"

func (r *Registry) SaveJob(ctx context.Context, job *JobRecord, ttl time.Duration) error {
	raw, err := json.Marshal(job)
	if err != nil {
		return err
	}
	pipe := r.rdb.TxPipeline()
	pipe.Set(ctx, jobKey(job.ID), raw, ttl)
	pipe.SAdd(ctx, workerJobsKey(job.WorkerID), job.ID)
	pipe.Expire(ctx, workerJobsKey(job.WorkerID), ttl)
	pipe.SAdd(ctx, jobsAllKey, job.ID)
	if job.RoomID != "" {
		pipe.SAdd(ctx, roomJobsKey(job.RoomID), job.ID)
		pipe.Expire(ctx, roomJobsKey(job.RoomID), ttl)
	}
	_, err = pipe.Exec(ctx)
	return err
}

// LoadJob reads a job, nil when unknown.
func (r *Registry) LoadJob(ctx context.Context, id string) (*JobRecord, error) {
	raw, err := r.rdb.Get(ctx, jobKey(id)).Bytes()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var job JobRecord
	if err := json.Unmarshal(raw, &job); err != nil {
		return nil, err
	}
	return &job, nil
}

func (r *Registry) DeleteJob(ctx context.Context, job *JobRecord) error {
	pipe := r.rdb.TxPipeline()
	pipe.Del(ctx, jobKey(job.ID))
	pipe.SRem(ctx, workerJobsKey(job.WorkerID), job.ID)
	pipe.SRem(ctx, jobsAllKey, job.ID)
	if job.RoomID != "" {
		pipe.SRem(ctx, roomJobsKey(job.RoomID), job.ID)
	}
	_, err := pipe.Exec(ctx)
	return err
}

func (r *Registry) JobsForRoom(ctx context.Context, roomID string) ([]string, error) {
	return r.rdb.SMembers(ctx, roomJobsKey(roomID)).Result()
}

func (r *Registry) JobsForWorker(ctx context.Context, workerID string) ([]string, error) {
	return r.rdb.SMembers(ctx, workerJobsKey(workerID)).Result()
}

func (r *Registry) AllJobs(ctx context.Context) ([]string, error) {
	return r.rdb.SMembers(ctx, jobsAllKey).Result()
}

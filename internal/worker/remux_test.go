package worker

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/remux"
	"github.com/giulianoo0/ss/internal/room"
)

func TestCoveredByRegionsCompletedRunLeavesGapsUncovered(t *testing.T) {
	regions := []room.MediaRegion{
		{N: 0, StartMs: 0, ProducedMs: 536_000},
		{N: 1, StartMs: 1_025_025, ProducedMs: 392_392},
	}
	completed := &RemuxRun{Region: 1, StartMs: 1_025_025, ProducedMs: 392_392, State: remux.RunCompleted}
	require.False(t, coveredByRegions(regions, completed, 700_000), "the gap between regions is uncovered")
	require.True(t, coveredByRegions(regions, completed, 1_100_000), "inside the completed region")
	require.True(t, coveredByRegions(regions, completed, 100_000), "inside the sealed first region")

	require.True(t, coveredByRegions(regions, completed, 1_025_025-followBehindMs), "just before a region is the region")
	require.False(t, coveredByRegions(regions, completed, 1_025_025-followBehindMs-1), "any earlier is the gap")

	live := &RemuxRun{Region: 1, StartMs: 1_025_025, ProducedMs: 100_000, State: remux.RunRunning}
	require.True(t, coveredByRegions(regions, live, 1_125_025+followAheadMs-1), "a live run's edge counts ahead")
	require.False(t, coveredByRegions(regions, completed, 1_417_417+followAheadMs-1), "a finished run has no edge ahead of it")
}

// The player loads a position up to REGION_BEHIND_MS before a region from
// that region; the server must never call covered what the player will not
// load, or nobody dispatches and the room waits forever.
func TestFollowBehindNeverExceedsThePlayersTolerance(t *testing.T) {
	require.LessOrEqual(t, int64(followBehindMs), int64(1_000))
}

func TestAdmitFollowHoldsTheLatestPositionInsideTheWindow(t *testing.T) {
	o := &RemuxOrchestrator{byRoom: map[string]*roomMutex{}, follows: map[string]*followState{}, followDebounce: 40 * time.Millisecond}
	require.True(t, o.admitFollow("r1", 1_000), "the first position acts at once")
	require.False(t, o.admitFollow("r1", 2_000), "inside the window it waits")
	require.False(t, o.admitFollow("r1", 3_000), "and the newest one replaces the one waiting")
	o.mu.Lock()
	require.NotNil(t, o.follows["r1"].pending)
	require.Equal(t, int64(3_000), *o.follows["r1"].pending)
	require.NotNil(t, o.follows["r1"].timer)
	o.follows["r1"].timer.Stop()
	o.mu.Unlock()

	time.Sleep(50 * time.Millisecond)
	require.True(t, o.admitFollow("r1", 4_000), "after the window a position acts again")
	require.True(t, o.admitFollow("r2", 5_000), "rooms do not share a window")
}

// sentJob is one job the fake worker received, with its remux block read.
type sentJob struct {
	Kind  string
	Remux remux.Spec
	RunID string
}

// remuxRig is an orchestrator wired to one healthy fake worker that says yes
// to every job, and a room whose first run already started at 0.
type remuxRig struct {
	o          *RemuxOrchestrator
	store      *room.Store
	jobs       chan sentJob
	generation int
}

func newRemuxRig(t *testing.T) *remuxRig {
	t.Helper()
	rdb := newRedisClient(t)
	store := room.NewStore(rdb, time.Hour)
	ctx := context.Background()
	now := time.Now()
	require.NoError(t, store.Create(ctx, &room.Room{ID: "r1", Status: room.StatusEmpty, ControllerID: "m1",
		CreatedAt: now, ExpiresAt: now.Add(time.Hour), OwnerToken: "owner"}))
	_, generation, err := store.SwapSource(ctx, "r1", "m1", "movie.mkv", "uploading", now)
	require.NoError(t, err)

	registry := NewRegistry(rdb, NewMemoryEnrollments())
	signer, err := LoadOrCreateSigner("")
	require.NoError(t, err)
	l := &link{workerID: "w", send: make(chan []byte, 64), pending: map[string]chan Result{}, closed: make(chan struct{})}
	registry.Attach(ctx, "w", "pk", "https://w", l)
	require.True(t, registry.Observe(ctx, "w", l, Heartbeat{Ready: true,
		Remux: &remux.Capability{ProtocolVersion: remux.ProtocolVersion, Slots: 4, FFmpeg: "8.1"}}))
	jobs := make(chan sentJob, 64)
	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })
	go func() {
		for {
			select {
			case <-stop:
				return
			case raw := <-l.send:
				var env Envelope
				if json.Unmarshal(raw, &env) != nil {
					continue
				}
				payload, _ := base64.RawURLEncoding.DecodeString(env.Payload)
				var job struct {
					Kind  string          `json:"kind"`
					JobID string          `json:"jobId"`
					Remux json.RawMessage `json:"remux"`
				}
				_ = json.Unmarshal(payload, &job)
				sent := sentJob{Kind: job.Kind}
				switch job.Kind {
				case "remuxStart":
					_ = json.Unmarshal(job.Remux, &sent.Remux)
				case "remuxCancel":
					var cancel map[string]string
					_ = json.Unmarshal(job.Remux, &cancel)
					sent.RunID = cancel["runId"]
				}
				jobs <- sent
				l.deliver(Result{JobID: job.JobID, OK: true})
			}
		}
	}()

	index := 0
	require.NoError(t, registry.SaveJob(ctx, &JobRecord{ID: "t_1", SessionID: "s", WorkerID: "w", State: JobServing,
		FileIndex: &index, Infohash: "ih", LeaseID: "lease", LastSeenAt: now}, time.Hour))
	o := NewRemuxOrchestrator(&Service{Registry: registry, Hub: &Hub{registry: registry, signer: signer}},
		store, config.Config{RoomTTLHours: 1})
	o.followDebounce = 0
	rig := &remuxRig{o: o, store: store, jobs: jobs, generation: generation}
	_, err = o.Start(ctx, "s", "t_1", remux.StartRequest{RoomID: "r1", MediaGeneration: generation, RequestID: "q",
		Auth: remux.StartAuth{OwnerToken: "owner"}}, nil)
	require.NoError(t, err)
	first := rig.next(t)
	require.Equal(t, "remuxStart", first.Kind)
	require.Equal(t, int64(0), first.Remux.StartMs)
	return rig
}

func (rig *remuxRig) next(t *testing.T) sentJob {
	t.Helper()
	select {
	case job := <-rig.jobs:
		return job
	case <-time.After(2 * time.Second):
		t.Fatal("the worker was told nothing")
		return sentJob{}
	}
}

func (rig *remuxRig) quiet(t *testing.T, within time.Duration) {
	t.Helper()
	select {
	case job := <-rig.jobs:
		t.Fatalf("the worker was told %s", job.Kind)
	case <-time.After(within):
	}
}

func (rig *remuxRig) run(t *testing.T) *RemuxRun {
	t.Helper()
	run, err := rig.o.LoadRun(context.Background(), "r1")
	require.NoError(t, err)
	require.NotNil(t, run)
	return run
}

func (rig *remuxRig) report(report remux.RunReport) {
	rig.o.ObserveHeartbeat("w", Heartbeat{Ready: true, Remux: &remux.Capability{ProtocolVersion: remux.ProtocolVersion,
		Slots: 4, FFmpeg: "8.1", Runs: []remux.RunReport{report}}})
}

func (rig *remuxRig) regions(t *testing.T, regions ...room.MediaRegion) {
	t.Helper()
	require.NoError(t, rig.store.SetMediaRegions(context.Background(), "r1", regions))
}

func TestFollowLeavesACoveredPositionAlone(t *testing.T) {
	rig := newRemuxRig(t)
	rig.regions(t, room.MediaRegion{N: 0, StartMs: 0, ProducedMs: 120_000, Growing: true})

	rig.o.Follow("r1", 60_000)

	rig.quiet(t, 100*time.Millisecond)
}

func TestFollowReplacesTheRunAtAnUncoveredPosition(t *testing.T) {
	rig := newRemuxRig(t)
	first := rig.run(t)
	rig.regions(t, room.MediaRegion{N: 0, StartMs: 0, ProducedMs: 120_000, Growing: true})

	rig.o.Follow("r1", 1_000_000)

	cancel := rig.next(t)
	require.Equal(t, "remuxCancel", cancel.Kind)
	require.Equal(t, first.RunID, cancel.RunID)
	start := rig.next(t)
	require.Equal(t, "remuxStart", start.Kind)
	require.Equal(t, int64(1_000_000), start.Remux.StartMs)
	require.Equal(t, 1, start.Remux.Region)
	require.Equal(t, rig.generation, start.Remux.MediaGeneration)
	require.Equal(t, start.Remux.RunID, rig.run(t).RunID)
}

func TestFollowInsideTheDebounceLandsWhereTheRoomEndedUp(t *testing.T) {
	rig := newRemuxRig(t)
	rig.o.followDebounce = 80 * time.Millisecond
	rig.regions(t, room.MediaRegion{N: 0, StartMs: 0, ProducedMs: 120_000, Growing: true})

	rig.o.Follow("r1", 1_000_000)
	require.Equal(t, "remuxCancel", rig.next(t).Kind)
	require.Equal(t, int64(1_000_000), rig.next(t).Remux.StartMs)
	rig.o.Follow("r1", 2_000_000)
	rig.o.Follow("r1", 3_000_000)
	rig.quiet(t, 30*time.Millisecond)

	require.Equal(t, "remuxCancel", rig.next(t).Kind)
	require.Equal(t, int64(3_000_000), rig.next(t).Remux.StartMs, "the held position was not the newest")
	rig.quiet(t, 150*time.Millisecond)
}

// A room's locks and debounce live only as long as the room: the process
// outlives thousands of them.
func TestCancelRoomForgetsTheRoom(t *testing.T) {
	rig := newRemuxRig(t)
	rig.o.followDebounce = time.Minute
	rig.o.Follow("r1", 1_000_000)
	rig.next(t)
	rig.next(t)
	rig.o.Follow("r1", 2_000_000)

	rig.o.CancelRoom("r1")

	require.Equal(t, "remuxCancel", rig.next(t).Kind)
	rig.o.mu.Lock()
	defer rig.o.mu.Unlock()
	require.Empty(t, rig.o.byRoom)
	require.Empty(t, rig.o.follows)
}

func TestARunningReportRenewsTheClaimAndRecordsProgress(t *testing.T) {
	rig := newRemuxRig(t)
	run := rig.run(t)

	rig.report(remux.RunReport{RunID: run.RunID, State: remux.RunRunning, ProducedMs: 42_000})

	after := rig.run(t)
	require.Equal(t, remux.RunRunning, after.State)
	require.Equal(t, int64(42_000), after.ProducedMs)
	stored, err := rig.store.Get(context.Background(), "r1")
	require.NoError(t, err)
	require.NotZero(t, stored.ProducerHeartbeatMs, "the claim was not renewed")
}

func TestAReportForAReplacedRunChangesNothing(t *testing.T) {
	rig := newRemuxRig(t)
	stale := rig.run(t)
	rig.o.Follow("r1", 1_000_000)
	rig.next(t)
	rig.next(t)

	rig.report(remux.RunReport{RunID: stale.RunID, State: remux.RunFailed, Error: "boom"})

	current := rig.run(t)
	require.NotEqual(t, stale.RunID, current.RunID)
	require.Equal(t, remux.RunAccepted, current.State)
	rig.quiet(t, 100*time.Millisecond)
}

func TestACompletedCoveringRunClampsTheDurationToWhatItProduced(t *testing.T) {
	rig := newRemuxRig(t)
	require.NoError(t, rig.store.SetMediaDuration(context.Background(), "r1", 1_500_000))
	run := rig.run(t)

	rig.report(remux.RunReport{RunID: run.RunID, State: remux.RunCompleted, ProducedMs: 1_497_000})

	stored, err := rig.store.Get(context.Background(), "r1")
	require.NoError(t, err)
	require.Equal(t, int64(1_497_000), stored.DurationMs)
	require.Equal(t, remux.RunCompleted, rig.run(t).State)
}

func TestAFailedRunRestartsPastWhatItProducedThenGivesUp(t *testing.T) {
	rig := newRemuxRig(t)
	rig.regions(t, room.MediaRegion{N: 0, StartMs: 0, ProducedMs: 300_000, Growing: true})

	for restart := 1; restart <= maxRunRestarts; restart++ {
		failed := rig.run(t)
		rig.report(remux.RunReport{RunID: failed.RunID, State: remux.RunFailed, Error: "ffmpeg died"})
		require.Equal(t, "lease", rig.next(t).Kind)
		require.Equal(t, "select", rig.next(t).Kind)
		start := rig.next(t)
		require.Equal(t, "remuxStart", start.Kind)
		require.Equal(t, int64(300_000), start.Remux.StartMs, "restart %d did not resume at the produced edge", restart)
		require.Eventually(t, func() bool {
			run := rig.run(t)
			return run.Restarts == restart && run.State == remux.RunAccepted
		}, time.Second, 5*time.Millisecond)
	}

	rig.report(remux.RunReport{RunID: rig.run(t).RunID, State: remux.RunFailed, Error: "ffmpeg died"})

	stored, err := rig.store.Get(context.Background(), "r1")
	require.NoError(t, err)
	require.Equal(t, "error", stored.Status)
	require.Equal(t, remux.RunFailed, rig.run(t).State)
}

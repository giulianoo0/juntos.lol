package worker

import (
	"context"
	"testing"
	"time"
)

func roomJobs(t *testing.T, r *Registry) []string {
	t.Helper()
	ids, err := r.JobsForRoom(context.Background(), "r1")
	if err != nil {
		t.Fatal(err)
	}
	var kinds []string
	for _, id := range ids {
		if job, err := r.LoadJob(context.Background(), id); err == nil && job != nil {
			kinds = append(kinds, job.Kind)
		}
	}
	return kinds
}

// The media and the live of a room play side by side, so cancelling one
// leaves the other's job alone.
func TestCancellingTheMediaLeavesTheLiveAndBack(t *testing.T) {
	r := newRegistry(t)
	s := &Service{Registry: r, Hub: &Hub{registry: r}}
	ctx := context.Background()
	for _, job := range []*JobRecord{
		{ID: "t_1", RoomID: "r1", Kind: "", WorkerID: "w"},
		{ID: "l_1", RoomID: "r1", Kind: JobKindLive, WorkerID: "w"},
	} {
		if err := r.SaveJob(ctx, job, time.Hour); err != nil {
			t.Fatal(err)
		}
	}

	s.CancelRoomMedia("r1")
	if got := roomJobs(t, r); len(got) != 1 || got[0] != JobKindLive {
		t.Fatalf("after cancelling the media: %v", got)
	}

	if err := r.SaveJob(ctx, &JobRecord{ID: "t_2", RoomID: "r1", WorkerID: "w"}, time.Hour); err != nil {
		t.Fatal(err)
	}
	s.CancelRoomLive("r1")
	if got := roomJobs(t, r); len(got) != 1 || got[0] != "" {
		t.Fatalf("after cancelling the live: %v", got)
	}
}

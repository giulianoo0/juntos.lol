package worker

import (
	"testing"
	"time"

	"github.com/giulianoo0/ss/internal/remux"
)

func TestYoutubePlacementWantsYtdlpAndAFreeSlot(t *testing.T) {
	r := newRegistry(t)
	s := &Service{Registry: r, Hub: &Hub{}}
	if got := s.YoutubeCapacity(); got != "disabled" {
		t.Fatalf("no link: %s", got)
	}
	s.Hub = nil
	if _, err := s.placeYoutube(time.Now()); err != ErrNoYoutube {
		t.Fatalf("empty fleet: %v", err)
	}
	live(r, "torrent-only", Heartbeat{MaxLeases: 8, MaxTorrents: 10,
		Remux: &remux.Capability{ProtocolVersion: remux.ProtocolVersion, FFmpeg: "7", Slots: 4}})
	if _, err := s.placeYoutube(time.Now()); err != ErrNoYoutube {
		t.Fatalf("worker without yt-dlp must not take links: %v", err)
	}
	live(r, "full", Heartbeat{MaxLeases: 8, MaxTorrents: 10,
		Remux: &remux.Capability{ProtocolVersion: remux.ProtocolVersion, FFmpeg: "7", Slots: 2, ActiveRuns: 2,
			Youtube: &remux.Youtube{Version: "2026.08.19"}}})
	if _, err := s.placeYoutube(time.Now()); err != ErrWorkersBusy {
		t.Fatalf("full worker: %v", err)
	}
	live(r, "roomy", Heartbeat{MaxLeases: 8, MaxTorrents: 10,
		Remux: &remux.Capability{ProtocolVersion: remux.ProtocolVersion, FFmpeg: "7", Slots: 4, ActiveRuns: 1,
			Youtube: &remux.Youtube{Version: "2026.08.19", Proxied: true}}})
	w, err := s.placeYoutube(time.Now())
	if err != nil || w.ID != "roomy" {
		t.Fatalf("placement: %v %q", err, w.ID)
	}
}

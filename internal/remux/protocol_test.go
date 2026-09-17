package remux

import "testing"

func TestCapabilityCompatible(t *testing.T) {
	if (&Capability{}).Compatible() {
		t.Error("empty capability must not be compatible")
	}
	var nilCap *Capability
	if nilCap.Compatible() {
		t.Error("nil capability must not be compatible")
	}
	good := &Capability{ProtocolVersion: ProtocolVersion, Slots: 1, FFmpeg: "7.1"}
	if !good.Compatible() {
		t.Error("announced capability with matching version must be compatible")
	}
	wrong := &Capability{ProtocolVersion: ProtocolVersion + 1, Slots: 1, FFmpeg: "7.1"}
	if wrong.Compatible() {
		t.Error("version mismatch must not be compatible")
	}
}

func TestTerminalState(t *testing.T) {
	for _, s := range []string{RunCompleted, RunCancelled, RunFailed} {
		if !TerminalState(s) {
			t.Errorf("%s should be terminal", s)
		}
	}
	for _, s := range []string{RunStarting, RunAccepted, RunRunning, RunDraining, RunCancelling} {
		if TerminalState(s) {
			t.Errorf("%s should not be terminal", s)
		}
	}
}

func TestTakesLiveNeedsYoutubeAndAFreeSlot(t *testing.T) {
	c := Capability{ProtocolVersion: ProtocolVersion, FFmpeg: "7.1", Slots: 1, Youtube: &Youtube{Version: "2026.08.19"}, LiveSlots: 1}
	if !c.TakesLive() {
		t.Fatal("a worker with yt-dlp and a free live slot takes lives")
	}
	c.ActiveLives = 1
	if c.TakesLive() {
		t.Fatal("a full worker does not take lives")
	}
	c.ActiveLives, c.Youtube = 0, nil
	if c.TakesLive() {
		t.Fatal("no yt-dlp, no lives")
	}
}

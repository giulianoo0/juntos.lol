package remux

import "testing"

func TestVideoPolicy(t *testing.T) {
	for codec, want := range map[string]VideoVerdict{
		"h264": VideoCopy, "avc": VideoCopy, "hevc": VideoCopy, "h265": VideoCopy,
		"vp9": VideoReject, "av1": VideoReject, "mpeg2video": VideoReject, "": VideoReject,
	} {
		if got := VideoPolicy(codec); got != want {
			t.Errorf("VideoPolicy(%q) = %v, want %v", codec, got, want)
		}
	}
}

func TestAudioPolicy(t *testing.T) {
	cases := []struct {
		codec    string
		channels int
		want     AudioVerdict
		wantErr  bool
	}{
		{"aac", 2, AudioCopy, false},
		{"aac", 6, AudioCopy, false},
		{"ac3", 6, AudioConvert, false},
		{"dts", 6, AudioConvert, false},
		{"dca", 2, AudioConvert, false},
		{"eac3", 6, AudioConvert, false},
		{"truehd", 8, AudioReject, true},
		{"opus", 2, AudioConvert, false},
		{"flac", 2, AudioConvert, false},
		{"aac", 0, AudioReject, true},
		{"aac", 9, AudioReject, true},
	}
	for _, c := range cases {
		got, err := AudioPolicy(c.codec, c.channels)
		if got != c.want || (err != nil) != c.wantErr {
			t.Errorf("AudioPolicy(%q, %d) = %v, err=%v; want %v, wantErr=%v",
				c.codec, c.channels, got, err, c.want, c.wantErr)
		}
	}
}

func TestAACBitrate(t *testing.T) {
	if AACBitrateFor(1) != 160_000 || AACBitrateFor(2) != 160_000 {
		t.Error("stereo/mono bitrate")
	}
	if AACBitrateFor(6) != 384_000 || AACBitrateFor(8) != 384_000 {
		t.Error("surround bitrate")
	}
}

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

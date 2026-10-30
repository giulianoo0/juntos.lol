package sync

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/config"
)

func TestDeviceClass(t *testing.T) {
	require.Equal(t, "iphone", deviceClass("Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15"))
	require.Equal(t, "android", deviceClass("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/153.0.0.0 Mobile Safari/537.36"))
	require.Equal(t, "desktop", deviceClass("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0"))
	require.Equal(t, "unknown", deviceClass(""))
}

func TestReadyReportCarriesLinkHealth(t *testing.T) {
	var report Inbound
	require.NoError(t, json.Unmarshal([]byte(`{
		"type":"ready","positionMs":1000,"bufferAheadMs":0,"stalled":true,
		"bandwidthKbps":6200,"mediaKbps":17100,"droppedFrames":30,"decodedFrames":1200
	}`), &report))

	var telemetry syncTelemetry
	telemetry.recordHealth(report)
	telemetry.recordHealth(Inbound{BandwidthKbps: 9800, MediaKbps: 17100, DroppedFrames: 60, DecodedFrames: 2400})

	require.Equal(t, int64(17100), telemetry.mediaKbps)
	require.Equal(t, int64(8000), telemetry.bandwidthAvg())
	require.Equal(t, int64(6200), telemetry.bandwidthMin)
	require.Equal(t, int64(9800), telemetry.lastBandwidth)
	require.Equal(t, int64(25), telemetry.droppedPermille())
}

func TestReportsWithoutHealthKeepTheLastReading(t *testing.T) {
	var telemetry syncTelemetry
	telemetry.recordHealth(Inbound{BandwidthKbps: 5000, MediaKbps: 4000, DroppedFrames: 1, DecodedFrames: 100})
	telemetry.recordHealth(Inbound{})

	require.Equal(t, int64(4000), telemetry.mediaKbps)
	require.Equal(t, int64(5000), telemetry.bandwidthAvg())
	require.Equal(t, int64(10), telemetry.droppedPermille())
}

// A rendition that could not be turned on is asked for again on the next
// thin reading, not given up on for the rest of the media.
func TestAThinLinkAsksAgainWhenTheRenditionDidNotTurnOn(t *testing.T) {
	hub, _, server := newHubTestServer(t, config.Config{})
	asked := make(chan string, 8)
	failing := true
	hub.OnThinLink(func(roomID string) error {
		asked <- roomID
		if failing {
			failing = false
			return errors.New("redis down")
		}
		return nil
	})
	viewer := dialHubWS(t, server)
	helloHubClient(t, viewer, "viewer", 1)
	thin := Inbound{Type: "ready", PositionMs: 1_000, BufferAheadMs: 4_000, BandwidthKbps: 3_500, MediaKbps: 3_000}

	for range 3 {
		require.NoError(t, viewer.WriteJSON(thin))
	}
	require.Equal(t, "r1", <-asked)
	requireNoEvent(t, viewer, 50*time.Millisecond)
	for range 3 {
		require.NoError(t, viewer.WriteJSON(thin))
	}
	requireNoEvent(t, viewer, 50*time.Millisecond)

	select {
	case <-asked:
	case <-time.After(time.Second):
		t.Fatal("the failed rendition was never asked for again")
	}
	require.Empty(t, asked, "asked again after it turned on")
}

func TestAThinLinkAsksTheRoomForALighterRendition(t *testing.T) {
	thin := Inbound{Type: "ready", PositionMs: 1_000, BufferAheadMs: 4_000, BandwidthKbps: 3_500, MediaKbps: 3_000}
	tests := []struct {
		name     string
		app      bool
		producer bool
		reports  []Inbound
		asked    bool
	}{
		{name: "bandwidth under 1.3 times the media", reports: []Inbound{thin, thin, thin}, asked: true},
		{name: "a single thin reading", reports: []Inbound{thin}},
		{name: "plenty of bandwidth", reports: []Inbound{
			{Type: "ready", BandwidthKbps: 9_000, MediaKbps: 3_000},
			{Type: "ready", BandwidthKbps: 9_000, MediaKbps: 3_000},
			{Type: "ready", BandwidthKbps: 9_000, MediaKbps: 3_000},
		}},
		{name: "stalls that keep coming", reports: []Inbound{
			{Type: "ready", Stalled: true}, {Type: "ready"}, {Type: "ready", Stalled: true},
		}, asked: true},
		{name: "an app playing the bucket", app: true, reports: []Inbound{thin, thin, thin}, asked: true},
		{name: "the app producing the source from its own cache", app: true, producer: true, reports: []Inbound{thin, thin, thin}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			hub, _, server := newHubTestServer(t, config.Config{})
			if tt.producer {
				hub, _, server, _ = localRoom(t)
			}
			asked := make(chan string, 4)
			hub.OnThinLink(func(roomID string) error { asked <- roomID; return nil })
			viewer := dialHubWS(t, server)
			if tt.app {
				helloApp(t, viewer, "viewer")
			} else {
				helloHubClient(t, viewer, "viewer", 1)
			}

			for _, report := range append(tt.reports, tt.reports...) {
				require.NoError(t, viewer.WriteJSON(report))
			}
			requireNoEvent(t, viewer, 50*time.Millisecond)

			if !tt.asked {
				require.Empty(t, asked)
				return
			}
			select {
			case roomID := <-asked:
				require.Equal(t, "r1", roomID)
			case <-time.After(time.Second):
				t.Fatal("the room never asked for a lighter rendition")
			}
			require.Empty(t, asked, "asked more than once")
		})
	}
}

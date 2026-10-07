package sync

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
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

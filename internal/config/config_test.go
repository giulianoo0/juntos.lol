package config

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// setMediaEnv supplies the object storage settings every boot now requires.
func setMediaEnv(t *testing.T) {
	t.Helper()
	t.Setenv("R2_ACCOUNT_ID", "account")
	t.Setenv("R2_BUCKET", "bucket")
	t.Setenv("R2_ACCESS_KEY_ID", "key")
	t.Setenv("R2_SECRET_ACCESS_KEY", "secret")
	t.Setenv("MEDIA_PUBLIC_URL", "https://media.example.test")
}

func TestLoadReadsObjectStoreEndpointOverride(t *testing.T) {
	setMediaEnv(t)
	t.Setenv("R2_ENDPOINT", "minio:9000")
	t.Setenv("R2_INSECURE", "1")

	cfg, err := Load()

	require.NoError(t, err)
	require.Equal(t, "minio:9000", cfg.R2Endpoint)
	require.True(t, cfg.R2Insecure)
}

func TestLoadDefaults(t *testing.T) {
	setMediaEnv(t)
	t.Setenv("REDIS_URL", "")
	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, 8080, cfg.Port)
	require.Equal(t, int64(51200), cfg.MaxUploadMB)
	require.Equal(t, int64(1), cfg.StreamStartMB)
	require.Equal(t, 2, cfg.FFmpegJobs)
	require.Equal(t, "web/dist", cfg.WebDir)
}

func TestLoadRefusesIncompleteMediaStorage(t *testing.T) {
	// Media has no disk fallback, so a missing setting is a room that breaks
	// the moment someone uploads to it. Better to never come up.
	setMediaEnv(t)
	t.Setenv("R2_SECRET_ACCESS_KEY", "")

	_, err := Load()

	require.ErrorContains(t, err, "R2_SECRET_ACCESS_KEY")
}

func TestLoadRefusesARoomThatOutlivesItsMedia(t *testing.T) {
	// A longer room TTL leaves a live room pointing at deleted segments.
	setMediaEnv(t)
	t.Setenv("ROOM_TTL_HOURS", "48")

	_, err := Load()

	require.ErrorContains(t, err, "outlives")
}

func TestLoadAllowsARoomTTLMatchingTheMediaLifecycle(t *testing.T) {
	// The two windows start at different moments: a room's expiry is fixed at
	// creation and never extended, while each object's own window starts when
	// it is written, which is always later. Equal windows therefore still
	// leave every object outliving the room that published it.
	setMediaEnv(t)
	t.Setenv("ROOM_TTL_HOURS", "5")

	cfg, err := Load()

	require.NoError(t, err)
	require.Equal(t, 5, cfg.RoomTTLHours)
}

func TestLoadDefaultsToReclaimingAnEmptyRoomQuickly(t *testing.T) {
	// A room nobody is in holds its Redis record, its disk directory and every
	// segment it published. Ninety seconds is long enough to survive a
	// reconnect and short enough that an abandoned room stops costing storage.
	setMediaEnv(t)

	cfg, err := Load()

	require.NoError(t, err)
	require.Equal(t, 90, cfg.RoomIdleSeconds)
}

func TestLoadTrimsTheMediaOrigin(t *testing.T) {
	// Playlist URLs join this with a key, and a doubled slash is a 404.
	setMediaEnv(t)
	t.Setenv("MEDIA_PUBLIC_URL", "https://media.example.test/")

	cfg, err := Load()

	require.NoError(t, err)
	require.Equal(t, "https://media.example.test", cfg.MediaPublicURL)
}

func TestLoadDefaultsTheMetricsEndpointToItsOwnPort(t *testing.T) {
	// The application's listener is published to the host; this one is not,
	// which is the whole reason it is a second listener.
	setMediaEnv(t)

	cfg, err := Load()

	require.NoError(t, err)
	require.Equal(t, 9090, cfg.MetricsPort)
	require.NotEqual(t, cfg.Port, cfg.MetricsPort)
}

func TestLoadRefusesANonNumericMetricsPort(t *testing.T) {
	// Falling back silently would leave the endpoint on a port nobody is
	// scraping, and a dashboard with no data reads exactly like an idle site.
	setMediaEnv(t)
	t.Setenv("METRICS_PORT", "nove-mil-e-noventa")

	_, err := Load()

	require.ErrorContains(t, err, "METRICS_PORT")
}

func TestLoadRefusesToShareTheApplicationPortWithMetrics(t *testing.T) {
	// Sharing it would publish the metrics endpoint through the same bind the
	// TLS proxy sits in front of.
	setMediaEnv(t)
	t.Setenv("PORT", "8080")
	t.Setenv("METRICS_PORT", "8080")

	_, err := Load()

	require.ErrorContains(t, err, "METRICS_PORT")
}

func TestLoadAllowsTurningTheMetricsEndpointOff(t *testing.T) {
	setMediaEnv(t)
	t.Setenv("METRICS_PORT", "0")

	cfg, err := Load()

	require.NoError(t, err)
	require.Equal(t, 0, cfg.MetricsPort)
}

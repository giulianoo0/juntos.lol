package config

import (
	"testing"

	"github.com/stretchr/testify/require"
)

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
	require.Equal(t, "web/dist", cfg.WebDir)
}

func TestLoadRefusesIncompleteMediaStorage(t *testing.T) {
	setMediaEnv(t)
	t.Setenv("R2_SECRET_ACCESS_KEY", "")

	_, err := Load()

	require.ErrorContains(t, err, "R2_SECRET_ACCESS_KEY")
}

func TestLoadRefusesARoomThatOutlivesItsMedia(t *testing.T) {
	setMediaEnv(t)
	t.Setenv("ROOM_TTL_HOURS", "48")

	_, err := Load()

	require.ErrorContains(t, err, "outlives")
}

func TestLoadAllowsARoomTTLMatchingTheMediaLifecycle(t *testing.T) {
	setMediaEnv(t)
	t.Setenv("ROOM_TTL_HOURS", "5")

	cfg, err := Load()

	require.NoError(t, err)
	require.Equal(t, 5, cfg.RoomTTLHours)
}

func TestLoadDefaultsToReclaimingAnEmptyRoomQuickly(t *testing.T) {
	setMediaEnv(t)

	cfg, err := Load()

	require.NoError(t, err)
	require.Equal(t, 60, cfg.RoomIdleSeconds)
}

func TestLoadTrimsTheMediaOrigin(t *testing.T) {
	setMediaEnv(t)
	t.Setenv("MEDIA_PUBLIC_URL", "https://media.example.test/")

	cfg, err := Load()

	require.NoError(t, err)
	require.Equal(t, "https://media.example.test", cfg.MediaPublicURL)
}

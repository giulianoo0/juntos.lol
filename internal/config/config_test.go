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

func TestLoadDefaults(t *testing.T) {
	setMediaEnv(t)
	t.Setenv("REDIS_URL", "")
	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, 8080, cfg.Port)
	require.Equal(t, int64(10240), cfg.MaxUploadMB)
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
	// The bucket lifecycle reclaims media a day after it is written, so a
	// longer room TTL would leave a live room pointing at deleted segments.
	setMediaEnv(t)
	t.Setenv("ROOM_TTL_HOURS", "48")

	_, err := Load()

	require.ErrorContains(t, err, "outlives")
}

func TestLoadTrimsTheMediaOrigin(t *testing.T) {
	// Playlist URLs join this with a key, and a doubled slash is a 404.
	setMediaEnv(t)
	t.Setenv("MEDIA_PUBLIC_URL", "https://media.example.test/")

	cfg, err := Load()

	require.NoError(t, err)
	require.Equal(t, "https://media.example.test", cfg.MediaPublicURL)
}

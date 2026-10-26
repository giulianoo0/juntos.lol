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

func TestLoadCapsRoomCreationByDefault(t *testing.T) {
	setMediaEnv(t)
	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, 30, cfg.RoomsPerIPPerHour)
}

func TestLoadDiscordApp(t *testing.T) {
	setMediaEnv(t)
	cfg, err := Load()
	require.NoError(t, err)
	require.False(t, cfg.DiscordEnabled())
	require.Equal(t, "https://discord.com/api/v10", cfg.DiscordAPIBase)

	t.Setenv("DISCORD_APP_ID", "123")
	t.Setenv("DISCORD_PUBLIC_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
	t.Setenv("DISCORD_BOT_TOKEN", "bot")
	t.Setenv("DISCORD_API_BASE", "http://discord.test/api/")
	cfg, err = Load()
	require.NoError(t, err)
	require.True(t, cfg.DiscordEnabled())
	require.Len(t, cfg.DiscordPublicKey, 32)
	require.Equal(t, "bot", cfg.DiscordBotToken)
	require.Equal(t, "http://discord.test/api", cfg.DiscordAPIBase)

	t.Setenv("DISCORD_PUBLIC_KEY", "not-hex")
	_, err = Load()
	require.Error(t, err)
}

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
	t.Setenv("DATABASE_URL", "")
	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, "postgres://localhost:5432/juntos?sslmode=disable", cfg.DatabaseURL)
	require.Equal(t, 8080, cfg.Port)
	require.Equal(t, int64(51200), cfg.MaxUploadMB)
	require.Equal(t, "web/dist", cfg.WebDir)
	require.Equal(t, 60, cfg.RoomIdleSeconds, "an empty room is reclaimed quickly")
	require.Equal(t, 30, cfg.RoomsPerIPPerHour, "room creation is capped")
}

func TestLoadReadsTheDatabaseURL(t *testing.T) {
	setMediaEnv(t)
	t.Setenv("DATABASE_URL", "postgres://juntos:s3cret@postgres:5432/juntos")

	cfg, err := Load()

	require.NoError(t, err)
	require.Equal(t, "postgres://juntos:s3cret@postgres:5432/juntos", cfg.DatabaseURL)
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

func TestLoadTrimsTheMediaOrigin(t *testing.T) {
	setMediaEnv(t)
	t.Setenv("MEDIA_PUBLIC_URL", "https://media.example.test/")

	cfg, err := Load()

	require.NoError(t, err)
	require.Equal(t, "https://media.example.test", cfg.MediaPublicURL)
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

func TestLoadDiscordLogin(t *testing.T) {
	tests := []struct {
		name     string
		appID    string
		clientID string
		secret   string
		origin   string
		wantID   string
		enabled  bool
	}{
		{name: "client id cai para o app id", appID: "app", secret: "s", origin: "https://juntos.lol", wantID: "app", enabled: true},
		{name: "client id próprio vence o app id", appID: "app", clientID: "client", secret: "s", origin: "https://juntos.lol", wantID: "client", enabled: true},
		{name: "sem secret o login fica desligado", appID: "app", origin: "https://juntos.lol", wantID: "app"},
		{name: "sem origem pública não há redirect", appID: "app", secret: "s", wantID: "app"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			setMediaEnv(t)
			t.Setenv("DISCORD_APP_ID", tt.appID)
			t.Setenv("DISCORD_CLIENT_ID", tt.clientID)
			t.Setenv("DISCORD_CLIENT_SECRET", tt.secret)
			t.Setenv("PUBLIC_ORIGIN", tt.origin)

			cfg, err := Load()

			require.NoError(t, err)
			require.Equal(t, tt.wantID, cfg.DiscordClientID)
			require.Equal(t, tt.enabled, cfg.DiscordLoginEnabled())
			if tt.enabled {
				require.Equal(t, tt.origin+"/api/auth/discord/callback", cfg.DiscordRedirectURI())
			}
		})
	}
}

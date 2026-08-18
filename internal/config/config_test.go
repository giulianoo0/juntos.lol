package config

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestLoadDefaults(t *testing.T) {
	t.Setenv("REDIS_URL", "")
	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, 8080, cfg.Port)
	require.Equal(t, int64(10240), cfg.MaxUploadMB)
	require.Equal(t, int64(1), cfg.StreamStartMB)
	require.Equal(t, 2, cfg.FFmpegJobs)
	require.Equal(t, "web/dist", cfg.WebDir)
}

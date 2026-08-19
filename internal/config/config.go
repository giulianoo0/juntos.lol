package config

import (
	"fmt"
	"os"
	"slices"
	"strconv"
	"strings"
)

// mediaLifecycleHours mirrors the bucket's own expiry rule. It is duplicated
// here on purpose: the application cannot read the rule, and a room outliving
// its media is worth refusing to boot over.
const mediaLifecycleHours = 24

type Config struct {
	Port              int
	DataDir           string
	WebDir            string
	RedisURL          string
	MaxUploadMB       int64
	StreamStartMB     int64
	RoomTTLHours      int
	MaxParticipants   int
	RoomIdleMinutes   int
	UploadIdleMinutes int
	FFmpegJobs        int
	LivekitURL        string
	LivekitAPIKey     string
	LivekitAPISecret  string
	TorrentBridgeURL  string
	R2AccountID       string
	R2Bucket          string
	R2AccessKeyID     string
	R2SecretAccessKey string
	// MediaPublicURL is the origin the bucket is served from. Playlists point
	// segments at it, so it is what a viewer actually fetches media from.
	MediaPublicURL string
}

func Load() (Config, error) {
	cfg := Config{
		Port:              8080,
		DataDir:           "/data",
		WebDir:            "web/dist",
		RedisURL:          "redis://localhost:6379",
		MaxUploadMB:       10240,
		StreamStartMB:     1,
		RoomTTLHours:      5,
		MaxParticipants:   20,
		RoomIdleMinutes:   10,
		UploadIdleMinutes: 10,
		FFmpegJobs:        2,
		LivekitURL:        "",
		LivekitAPIKey:     "",
		LivekitAPISecret:  "",
	}

	var err error
	if cfg.Port, err = envInt("PORT", cfg.Port); err != nil {
		return Config{}, err
	}
	if v := os.Getenv("DATA_DIR"); v != "" {
		cfg.DataDir = v
	}
	if v := os.Getenv("WEB_DIR"); v != "" {
		cfg.WebDir = v
	}
	if v := os.Getenv("REDIS_URL"); v != "" {
		cfg.RedisURL = v
	}
	if cfg.MaxUploadMB, err = envInt64("MAX_UPLOAD_MB", cfg.MaxUploadMB); err != nil {
		return Config{}, err
	}
	if cfg.UploadIdleMinutes, err = envInt("UPLOAD_IDLE_MINUTES", cfg.UploadIdleMinutes); err != nil {
		return Config{}, err
	}
	if cfg.StreamStartMB, err = envInt64("STREAM_START_MB", cfg.StreamStartMB); err != nil {
		return Config{}, err
	}
	if cfg.RoomTTLHours, err = envInt("ROOM_TTL_HOURS", cfg.RoomTTLHours); err != nil {
		return Config{}, err
	}
	if cfg.MaxParticipants, err = envInt("MAX_PARTICIPANTS", cfg.MaxParticipants); err != nil {
		return Config{}, err
	}
	if cfg.RoomIdleMinutes, err = envInt("ROOM_IDLE_MINUTES", cfg.RoomIdleMinutes); err != nil {
		return Config{}, err
	}
	if cfg.FFmpegJobs, err = envInt("FFMPEG_JOBS", cfg.FFmpegJobs); err != nil {
		return Config{}, err
	}
	cfg.LivekitURL = os.Getenv("LIVEKIT_URL")
	cfg.LivekitAPIKey = os.Getenv("LIVEKIT_API_KEY")
	cfg.LivekitAPISecret = os.Getenv("LIVEKIT_API_SECRET")
	cfg.TorrentBridgeURL = os.Getenv("TORRENT_BRIDGE_URL")

	cfg.R2AccountID = os.Getenv("R2_ACCOUNT_ID")
	cfg.R2Bucket = os.Getenv("R2_BUCKET")
	cfg.R2AccessKeyID = os.Getenv("R2_ACCESS_KEY_ID")
	cfg.R2SecretAccessKey = os.Getenv("R2_SECRET_ACCESS_KEY")
	cfg.MediaPublicURL = strings.TrimSuffix(os.Getenv("MEDIA_PUBLIC_URL"), "/")
	if err := cfg.validateMedia(); err != nil {
		return Config{}, err
	}

	return cfg, nil
}

// validateMedia fails the boot on incomplete object storage settings. Media
// has no disk fallback, so a missing variable is a room that breaks the
// moment someone uploads to it — better to never come up than to come up
// broken.
func (c Config) validateMedia() error {
	missing := []string{}
	for name, value := range map[string]string{
		"R2_ACCOUNT_ID":        c.R2AccountID,
		"R2_BUCKET":            c.R2Bucket,
		"R2_ACCESS_KEY_ID":     c.R2AccessKeyID,
		"R2_SECRET_ACCESS_KEY": c.R2SecretAccessKey,
		"MEDIA_PUBLIC_URL":     c.MediaPublicURL,
	} {
		if value == "" {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		slices.Sort(missing)
		return fmt.Errorf("config: media storage needs %s", strings.Join(missing, ", "))
	}
	// The bucket lifecycle reclaims media a day after it is written, so a
	// longer room TTL would outlive its own video.
	if c.RoomTTLHours >= mediaLifecycleHours {
		return fmt.Errorf("config: ROOM_TTL_HOURS=%d outlives the %dh media lifecycle",
			c.RoomTTLHours, mediaLifecycleHours)
	}
	return nil
}

func envInt(key string, fallback int) (int, error) {
	v := os.Getenv(key)
	if v == "" {
		return fallback, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("config: invalid %s=%q: %w", key, v, err)
	}
	return n, nil
}

func envInt64(key string, fallback int64) (int64, error) {
	v := os.Getenv(key)
	if v == "" {
		return fallback, nil
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("config: invalid %s=%q: %w", key, v, err)
	}
	return n, nil
}

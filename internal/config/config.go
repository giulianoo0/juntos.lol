package config

import (
	"fmt"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
)

const mediaLifecycleHours = 5

type Config struct {
	Port              int
	DataDir           string
	WebDir            string
	RedisURL          string
	MaxUploadMB       int64
	RoomTTLHours      int
	MaxParticipants   int
	RoomIdleSeconds   int
	UploadIdleMinutes int
	LivekitURL        string
	LivekitAPIKey     string
	LivekitAPISecret  string
	R2AccountID       string
	R2Bucket          string
	R2AccessKeyID     string
	R2SecretAccessKey string
	R2Endpoint        string
	R2Insecure        bool
	MediaPublicURL    string

	SessionTTLDays         int
	SessionsPerIPPerHour   int
	TorrentDispatchPerHour int
	TorrentConcurrentJobs  int
	TorrentBytesPerDayGB   int64
	TorrentBlocklistFile   string

	WorkerEnrollmentSecret string
	WorkerSigningKeyFile   string
	WorkerTicketMinutes    int
	PublicOrigin           string
	BehindCloudflare       bool
	WorkerRelayBase        string

	RemoteRemuxEnabled bool
	RemoteRemuxAPIBase string

	// PluginFetchProxy is a proxy the plugin hop sends its requests through
	// (http, https or socks5 url). Set when the instance's own address is
	// one an addon refuses: the hop then leaves from wherever the proxy is.
	// Empty means the hop dials addons itself.
	PluginFetchProxy string
}

func Load() (Config, error) {
	cfg := Config{
		Port:              8080,
		DataDir:           "/data",
		WebDir:            "web/dist",
		RedisURL:          "redis://localhost:6379",
		MaxUploadMB:       51200,
		RoomTTLHours:      5,
		MaxParticipants:   20,
		RoomIdleSeconds:   60,
		UploadIdleMinutes: 10,
		LivekitURL:        "",
		LivekitAPIKey:     "",
		LivekitAPISecret:  "",

		SessionTTLDays:         7,
		SessionsPerIPPerHour:   20,
		TorrentDispatchPerHour: 10,
		TorrentConcurrentJobs:  2,
		TorrentBytesPerDayGB:   60,
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
	if cfg.RoomTTLHours, err = envInt("ROOM_TTL_HOURS", cfg.RoomTTLHours); err != nil {
		return Config{}, err
	}
	if cfg.MaxParticipants, err = envInt("MAX_PARTICIPANTS", cfg.MaxParticipants); err != nil {
		return Config{}, err
	}
	if cfg.RoomIdleSeconds, err = envInt("ROOM_IDLE_SECONDS", cfg.RoomIdleSeconds); err != nil {
		return Config{}, err
	}
	cfg.LivekitURL = os.Getenv("LIVEKIT_URL")
	cfg.LivekitAPIKey = os.Getenv("LIVEKIT_API_KEY")
	cfg.LivekitAPISecret = os.Getenv("LIVEKIT_API_SECRET")

	cfg.R2Endpoint = os.Getenv("R2_ENDPOINT")
	cfg.R2Insecure = os.Getenv("R2_INSECURE") == "1"
	cfg.R2AccountID = os.Getenv("R2_ACCOUNT_ID")
	cfg.R2Bucket = os.Getenv("R2_BUCKET")
	cfg.R2AccessKeyID = os.Getenv("R2_ACCESS_KEY_ID")
	cfg.R2SecretAccessKey = os.Getenv("R2_SECRET_ACCESS_KEY")
	cfg.MediaPublicURL = strings.TrimSuffix(os.Getenv("MEDIA_PUBLIC_URL"), "/")
	if err := cfg.validateMedia(); err != nil {
		return Config{}, err
	}

	if cfg.SessionTTLDays, err = envInt("SESSION_TTL_DAYS", cfg.SessionTTLDays); err != nil {
		return Config{}, err
	}
	if cfg.SessionsPerIPPerHour, err = envInt("SESSIONS_PER_IP_PER_HOUR", cfg.SessionsPerIPPerHour); err != nil {
		return Config{}, err
	}
	if cfg.TorrentDispatchPerHour, err = envInt("TORRENT_DISPATCH_PER_HOUR", cfg.TorrentDispatchPerHour); err != nil {
		return Config{}, err
	}
	if cfg.TorrentConcurrentJobs, err = envInt("TORRENT_CONCURRENT_JOBS", cfg.TorrentConcurrentJobs); err != nil {
		return Config{}, err
	}
	if cfg.TorrentBytesPerDayGB, err = envInt64("TORRENT_BYTES_PER_DAY_GB", cfg.TorrentBytesPerDayGB); err != nil {
		return Config{}, err
	}
	cfg.TorrentBlocklistFile = os.Getenv("TORRENT_BLOCKLIST_FILE")
	cfg.WorkerEnrollmentSecret = os.Getenv("WORKER_ENROLLMENT_SECRET")
	cfg.WorkerSigningKeyFile = os.Getenv("WORKER_SIGNING_KEY_FILE")
	if cfg.WorkerTicketMinutes, err = envInt("WORKER_TICKET_MINUTES", 15); err != nil {
		return Config{}, err
	}
	cfg.PublicOrigin = strings.TrimSuffix(os.Getenv("PUBLIC_ORIGIN"), "/")
	cfg.BehindCloudflare = os.Getenv("TRUSTED_EDGE") == "cloudflare"
	cfg.WorkerRelayBase = strings.TrimSuffix(os.Getenv("WORKER_RELAY_BASE"), "/")
	cfg.RemoteRemuxEnabled = os.Getenv("REMOTE_REMUX") == "1"
	cfg.RemoteRemuxAPIBase = strings.TrimSuffix(os.Getenv("REMOTE_REMUX_API_BASE"), "/")
	cfg.PluginFetchProxy = strings.TrimSpace(os.Getenv("PLUGIN_FETCH_PROXY"))
	if cfg.PluginFetchProxy != "" {
		// A proxy that does not parse must stop the boot, not silently
		// leave the hop dialing from the address the proxy exists to avoid.
		u, err := url.Parse(cfg.PluginFetchProxy)
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https" && u.Scheme != "socks5") {
			return Config{}, fmt.Errorf("PLUGIN_FETCH_PROXY must be an http, https or socks5 url")
		}
	}
	if cfg.RemoteRemuxAPIBase == "" {
		cfg.RemoteRemuxAPIBase = cfg.PublicOrigin
	}

	return cfg, nil
}

// validateMedia fails the boot on incomplete object storage settings: media
// has no disk fallback, so a missing variable is a room that breaks on the
// first upload.
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
	if c.RoomTTLHours > mediaLifecycleHours {
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

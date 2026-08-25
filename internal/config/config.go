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
const mediaLifecycleHours = 5

type Config struct {
	Port int
	// MetricsPort is where the Prometheus endpoint listens. It is a second
	// listener rather than a route on the main one because the application is
	// published to the host and this is not: nothing outside the Compose
	// network ever reaches it. 0 turns the endpoint off entirely.
	MetricsPort       int
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
	// R2Endpoint overrides the account-derived Cloudflare endpoint, so a
	// local MinIO can stand in for the bucket during development and tests.
	// Empty in production.
	R2Endpoint string
	// R2Insecure allows plain HTTP to the override endpoint. Never set in
	// production; a local container has no certificate to offer.
	R2Insecure bool
	// MediaPublicURL is the origin the bucket is served from. Playlists point
	// segments at it, so it is what a viewer actually fetches media from.
	MediaPublicURL string

	// Torrent access. Opening a magnet spends a worker's disk and uplink, so
	// the anonymous browser asking for it gets a session and a budget; the
	// rooms themselves stay as open as they are.
	SessionTTLDays         int
	SessionsPerIPPerHour   int
	TorrentDispatchPerHour int
	TorrentConcurrentJobs  int
	TorrentBytesPerDayGB   int64
	// TorrentBlocklistFile lists infohashes and name keywords never dispatched.
	// Empty means no list.
	TorrentBlocklistFile string

	// The worker fleet. Without an enrollment secret no worker can join and
	// the torrent path reports itself disabled; the instance still boots.
	WorkerEnrollmentSecret string
	// WorkerSigningKeyFile persists the Ed25519 key jobs and tickets are
	// signed with. Empty means a fresh key per boot (tickets die with it).
	WorkerSigningKeyFile string
	// WorkerTicketMinutes is how long a data-plane ticket stays valid.
	WorkerTicketMinutes int
	// PublicOrigin is the origin browsers load the app from, which tickets
	// are scoped to. Empty falls back to the request's own Origin header.
	PublicOrigin string
}

func Load() (Config, error) {
	cfg := Config{
		Port:              8080,
		MetricsPort:       9090,
		DataDir:           "/data",
		WebDir:            "web/dist",
		RedisURL:          "redis://localhost:6379",
		MaxUploadMB:       51200,
		RoomTTLHours:      5,
		MaxParticipants:   20,
		RoomIdleSeconds:   90,
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
	if cfg.MetricsPort, err = envInt("METRICS_PORT", cfg.MetricsPort); err != nil {
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
	// Sharing a port would put the metrics endpoint on the listener that is
	// published to the host, which is the one thing its own listener exists
	// to avoid.
	if cfg.MetricsPort != 0 && cfg.MetricsPort == cfg.Port {
		return Config{}, fmt.Errorf("config: METRICS_PORT=%d is the application's own port", cfg.MetricsPort)
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
	// A room must not outlive its own video. Equal windows are fine: media is
	// only ever written after the room exists and the room's expiry is never
	// extended, so every object's own window ends after the room's does.
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

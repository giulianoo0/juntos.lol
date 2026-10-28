package config

import (
	"crypto/ed25519"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
)

const mediaLifecycleHours = 5

type Config struct {
	Port     int
	DataDir  string
	WebDir   string
	RedisURL string
	// DatabaseURL is the Postgres that keeps accounts and enrolled workers.
	DatabaseURL       string
	MaxUploadMB       int64
	RoomTTLHours      int
	MaxParticipants   int
	RoomIdleSeconds   int
	UploadIdleMinutes int
	MoqRelayURL       string
	MoqPublishToken   string
	MoqSubscribeToken string
	// MoqBridgeURL is where WebKit viewers reach the relay's broadcasts over
	// WebSocket (ss-moq-bridge); relative to the site, or absolute. Empty
	// leaves them without screens.
	MoqBridgeURL      string
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

	RemoteRemuxAPIBase string

	PluginFetchProxy string

	// RoomsPerIPPerHour caps room creation per client address; 0 turns it off.
	RoomsPerIPPerHour int

	// The Discord app behind /juntos new. Without an app id and public key
	// the interactions endpoint is not mounted; without a bot token the room
	// card can only be posted while the interaction's own token lasts.
	DiscordAppID     string
	DiscordPublicKey ed25519.PublicKey
	DiscordBotToken  string
	DiscordAPIBase   string

	// Sign-in with Discord. The client id falls back to the app's; without a
	// secret and a public origin to come back to, the login routes are off.
	DiscordClientID     string
	DiscordClientSecret string

	// Turnstile in front of opening and entering rooms; without a secret
	// nobody is asked. Hostnames are where the widget may have been solved.
	// CatalogAddonURL is the Stremio-protocol addon the catalog reads, in the
	// browser; the server only hands its address over.
	CatalogAddonURL string

	TurnstileSiteKey   string
	TurnstileSecret    string
	TurnstileHostnames []string
}

// DiscordLoginEnabled reports whether accounts can be signed into through Discord.
func (c Config) DiscordLoginEnabled() bool {
	return c.DiscordClientID != "" && c.DiscordClientSecret != "" && c.PublicOrigin != ""
}

// DiscordRedirectURI is where Discord sends the browser back after sign-in;
// it must be registered as is in the app's OAuth2 settings.
func (c Config) DiscordRedirectURI() string {
	return c.PublicOrigin + "/api/auth/discord/callback"
}

// DiscordEnabled reports whether the interactions endpoint can verify Discord's calls.
func (c Config) DiscordEnabled() bool {
	return c.DiscordAppID != "" && len(c.DiscordPublicKey) == ed25519.PublicKeySize
}

func Load() (Config, error) {
	cfg := Config{
		Port:              8080,
		DataDir:           "/data",
		WebDir:            "web/dist",
		RedisURL:          "redis://localhost:6379",
		DatabaseURL:       "postgres://localhost:5432/juntos?sslmode=disable",
		MaxUploadMB:       51200,
		RoomTTLHours:      5,
		MaxParticipants:   20,
		RoomIdleSeconds:   60,
		UploadIdleMinutes: 10,

		SessionTTLDays:         7,
		SessionsPerIPPerHour:   20,
		TorrentDispatchPerHour: 10,
		TorrentConcurrentJobs:  2,
		TorrentBytesPerDayGB:   60,
		RoomsPerIPPerHour:      30,
		DiscordAPIBase:         "https://discord.com/api/v10",
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
	if v := os.Getenv("DATABASE_URL"); v != "" {
		cfg.DatabaseURL = v
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
	cfg.MoqRelayURL = strings.TrimSuffix(strings.TrimSpace(os.Getenv("MOQ_RELAY_URL")), "/")
	cfg.MoqPublishToken = strings.TrimSpace(os.Getenv("MOQ_PUBLISH_TOKEN"))
	cfg.MoqSubscribeToken = strings.TrimSpace(os.Getenv("MOQ_SUBSCRIBE_TOKEN"))
	cfg.MoqBridgeURL = strings.TrimSuffix(strings.TrimSpace(os.Getenv("MOQ_BRIDGE_URL")), "/")
	if err := cfg.validateScreenshare(); err != nil {
		return Config{}, err
	}

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
	cfg.RemoteRemuxAPIBase = strings.TrimSuffix(os.Getenv("REMOTE_REMUX_API_BASE"), "/")
	cfg.PluginFetchProxy = strings.TrimSpace(os.Getenv("PLUGIN_FETCH_PROXY"))
	if cfg.PluginFetchProxy != "" {
		u, err := url.Parse(cfg.PluginFetchProxy)
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https" && u.Scheme != "socks5") {
			return Config{}, fmt.Errorf("PLUGIN_FETCH_PROXY must be an http, https or socks5 url")
		}
	}
	if cfg.RemoteRemuxAPIBase == "" {
		cfg.RemoteRemuxAPIBase = cfg.PublicOrigin
	}
	if cfg.RoomsPerIPPerHour, err = envInt("ROOMS_PER_IP_PER_HOUR", cfg.RoomsPerIPPerHour); err != nil {
		return Config{}, err
	}
	cfg.CatalogAddonURL = strings.TrimSuffix(strings.TrimSpace(os.Getenv("CATALOG_ADDON_URL")), "/")
	if cfg.CatalogAddonURL == "" {
		cfg.CatalogAddonURL = "https://tmdb.elfhosted.com"
	}
	cfg.TurnstileSiteKey = strings.TrimSpace(os.Getenv("TURNSTILE_SITE_KEY"))
	cfg.TurnstileSecret = strings.TrimSpace(os.Getenv("TURNSTILE_SECRET"))
	for _, host := range strings.Split(os.Getenv("TURNSTILE_HOSTNAMES"), ",") {
		if host = strings.TrimSpace(host); host != "" {
			cfg.TurnstileHostnames = append(cfg.TurnstileHostnames, host)
		}
	}
	if cfg.TurnstileSecret != "" && (cfg.TurnstileSiteKey == "" || len(cfg.TurnstileHostnames) == 0) {
		return Config{}, fmt.Errorf("TURNSTILE_SITE_KEY and TURNSTILE_HOSTNAMES are required with TURNSTILE_SECRET")
	}
	cfg.DiscordAppID = strings.TrimSpace(os.Getenv("DISCORD_APP_ID"))
	cfg.DiscordBotToken = strings.TrimSpace(os.Getenv("DISCORD_BOT_TOKEN"))
	cfg.DiscordClientID = strings.TrimSpace(os.Getenv("DISCORD_CLIENT_ID"))
	if cfg.DiscordClientID == "" {
		cfg.DiscordClientID = cfg.DiscordAppID
	}
	cfg.DiscordClientSecret = strings.TrimSpace(os.Getenv("DISCORD_CLIENT_SECRET"))
	if v := strings.TrimSuffix(strings.TrimSpace(os.Getenv("DISCORD_API_BASE")), "/"); v != "" {
		cfg.DiscordAPIBase = v
	}
	if v := strings.TrimSpace(os.Getenv("DISCORD_PUBLIC_KEY")); v != "" {
		key, err := hex.DecodeString(v)
		if err != nil || len(key) != ed25519.PublicKeySize {
			return Config{}, fmt.Errorf("config: DISCORD_PUBLIC_KEY must be the app's 32-byte hex public key")
		}
		cfg.DiscordPublicKey = key
	}

	return cfg, nil
}

// ScreenshareEnabled reports whether screen sharing has a relay to run on.
// Rooms of every other kind work without one.
func (c Config) ScreenshareEnabled() bool {
	return c.MoqRelayURL != "" && c.MoqPublishToken != "" && c.MoqSubscribeToken != ""
}

// validateScreenshare accepts no relay at all or a complete one: a partial
// setting would hand out a URL nobody can connect to.
func (c Config) validateScreenshare() error {
	if c.MoqRelayURL == "" && c.MoqPublishToken == "" && c.MoqSubscribeToken == "" {
		return nil
	}
	if !c.ScreenshareEnabled() {
		return fmt.Errorf("config: screen sharing needs MOQ_RELAY_URL, MOQ_PUBLISH_TOKEN and MOQ_SUBSCRIBE_TOKEN together")
	}
	u, err := url.Parse(c.MoqRelayURL)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return fmt.Errorf("config: MOQ_RELAY_URL must be an https url")
	}
	return nil
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

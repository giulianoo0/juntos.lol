use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{bail, Context};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TlsMode {
    Acme,
    /// Certificate and key from files someone else renews (tailscale cert,
    /// an existing proxy's PKI). Re-read periodically so renewals land.
    File,
    SelfSigned,
    Off,
}

#[derive(Clone, Debug)]
pub struct WorkerConfig {
    pub server_url: String,
    pub enrollment_token: Option<String>,
    pub data_dir: PathBuf,
    pub public_ip: Option<IpAddr>,
    pub public_hostname: Option<String>,
    pub bt_listen_port: u16,
    pub https_addr: SocketAddr,
    pub http_addr: SocketAddr,
    pub metrics_addr: SocketAddr,
    pub tls: TlsMode,
    pub acme_directory: String,
    pub acme_contact: Option<String>,
    pub acme_profile: String,
    /// TLS=file: the PEM pair to serve, re-read hourly.
    pub tls_cert_file: Option<std::path::PathBuf>,
    pub tls_key_file: Option<std::path::PathBuf>,
    pub disk_quota_bytes: u64,
    pub disk_high_water_pct: u8,
    pub max_torrents: usize,
    pub max_leases: usize,
    pub per_torrent_peer_limit: usize,
    pub upload_bps: u32,
    pub download_bps: u32,
    /// Ceiling on the data plane's egress to browsers, bytes per second.
    /// 0 is uncapped. A worker near this ceiling reports itself full.
    pub transfer_bps: u64,
    pub idle_grace: Duration,
    pub reap_ttl: Duration,
    pub runtime_worker_threads: usize,
    /// This worker asks to be reached through the fleet's relay instead of
    /// directly: its address is private and stays that way.
    pub relayed: bool,
    /// Where this worker forwards /relay/* to (the site's app), making it
    /// the fleet's front door for relayed siblings. Empty disables.
    pub relay_upstream: Option<String>,
    pub response_cap: u64,
    pub first_byte_deadline: Duration,
    pub stall_deadline: Duration,
    pub drain_deadline: Duration,

    /// Remote remux. 0 slots disables the capability entirely.
    pub remux_slots: usize,
    pub ffmpeg_path: String,
    pub ffprobe_path: String,
    pub remux_spool_bytes: u64,
    pub remux_object_bytes: u64,
    pub remux_put_concurrency: usize,
    pub remux_put_global: usize,
    /// How far past the room's playhead a run produces at full speed before
    /// throttling to share the box, in milliseconds.
    #[allow(dead_code)]
    pub remux_ahead_ms: u64,
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn env_parse<T: std::str::FromStr>(name: &str, default: T) -> anyhow::Result<T>
where
    T::Err: std::fmt::Display,
{
    match env(name) {
        None => Ok(default),
        Some(v) => v.parse().map_err(|e| anyhow::anyhow!("{name}={v}: {e}")),
    }
}

fn env_secs(name: &str, default: u64) -> anyhow::Result<Duration> {
    Ok(Duration::from_secs(env_parse(name, default)?))
}

const GB: u64 = 1024 * 1024 * 1024;
/// Used only when the filesystem will not say how big it is.
const QUOTA_FALLBACK_GB: u64 = 120;
/// Share of the filesystem the torrents may claim when nobody said. The rest
/// is for the certificates, the logs and whatever else lives on the volume.
const QUOTA_SHARE_PCT: u64 = 80;

/// Bytes on the filesystem holding `dir`, as the kernel reports it.
#[cfg(unix)]
fn filesystem_bytes(dir: &std::path::Path) -> Option<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let path = CString::new(dir.as_os_str().as_bytes()).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(path.as_ptr(), &mut stat) } != 0 {
        return None;
    }
    let total = stat.f_blocks as u64 * stat.f_frsize as u64;
    (total > 0).then_some(total)
}

#[cfg(not(unix))]
fn filesystem_bytes(_dir: &std::path::Path) -> Option<u64> {
    None
}

/// A quota larger than the disk is not a quota: the accountant keeps admitting
/// torrents until the filesystem answers ENOSPC, which librqbit turns into a
/// torrent in Error and a rescan of everything it had. So the default follows
/// the filesystem, and a configured one is held to it.
fn disk_quota_bytes(data_dir: &std::path::Path) -> anyhow::Result<u64> {
    let _ = std::fs::create_dir_all(data_dir);
    let ceiling = filesystem_bytes(data_dir).map(|total| total / 100 * QUOTA_SHARE_PCT);
    let asked = match env("SS_WORKER_DISK_QUOTA_GB") {
        Some(_) => Some(env_parse::<u64>("SS_WORKER_DISK_QUOTA_GB", QUOTA_FALLBACK_GB)? * GB),
        None => None,
    };
    Ok(match (asked, ceiling) {
        (Some(asked), Some(ceiling)) if asked > ceiling => {
            tracing::warn!(
                asked_gb = asked / GB,
                using_gb = ceiling / GB,
                dir = %data_dir.display(),
                "SS_WORKER_DISK_QUOTA_GB does not fit the filesystem; holding it to what is there",
            );
            ceiling
        }
        (Some(asked), _) => asked,
        (None, Some(ceiling)) => ceiling,
        (None, None) => QUOTA_FALLBACK_GB * GB,
    })
}

/// Loads KEY=VALUE lines into the environment, real env winning. The setup
/// wizard writes this file so a bare `ss-worker` starts configured.
pub fn load_env_file(path: &std::path::Path) -> anyhow::Result<usize> {
    let raw = std::fs::read_to_string(path)?;
    let mut loaded = 0;
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let (key, value) = (key.trim(), value.trim().trim_matches('"'));
        if std::env::var(key).map(|v| v.is_empty()).unwrap_or(true) {
            std::env::set_var(key, value);
            loaded += 1;
        }
    }
    Ok(loaded)
}

impl WorkerConfig {
    pub fn load() -> anyhow::Result<Self> {
        let tls = match env("SS_WORKER_TLS").as_deref().unwrap_or("acme") {
            "acme" => TlsMode::Acme,
            "file" => TlsMode::File,
            "self-signed" => TlsMode::SelfSigned,
            "off" => TlsMode::Off,
            other => bail!("SS_WORKER_TLS={other}: expected acme, file, self-signed or off"),
        };
        let public_ip = match env("SS_WORKER_PUBLIC_IP") {
            Some(v) => Some(v.parse().context("SS_WORKER_PUBLIC_IP")?),
            None => None,
        };
        let data_dir = PathBuf::from(env("SS_WORKER_DATA_DIR").unwrap_or_else(|| "./data".into()));
        let cfg = Self {
            server_url: env("SS_WORKER_SERVER_URL").context("SS_WORKER_SERVER_URL is required")?,
            enrollment_token: env("SS_WORKER_ENROLLMENT_TOKEN"),
            disk_quota_bytes: disk_quota_bytes(&data_dir)?,
            data_dir,
            public_ip,
            public_hostname: env("SS_WORKER_PUBLIC_HOSTNAME"),
            bt_listen_port: env_parse("SS_WORKER_BT_PORT", 4240)?,
            https_addr: env_parse("SS_WORKER_HTTPS_ADDR", "[::]:443".parse().unwrap())?,
            http_addr: env_parse("SS_WORKER_HTTP_ADDR", "[::]:80".parse().unwrap())?,
            metrics_addr: env_parse("SS_WORKER_METRICS_ADDR", "127.0.0.1:9101".parse().unwrap())?,
            tls,
            acme_directory: env("SS_WORKER_ACME_DIRECTORY")
                .unwrap_or_else(|| "https://acme-v02.api.letsencrypt.org/directory".into()),
            acme_contact: env("SS_WORKER_ACME_CONTACT"),
            acme_profile: env("SS_WORKER_ACME_PROFILE").unwrap_or_else(|| "shortlived".into()),
            tls_cert_file: env("SS_WORKER_TLS_CERT").map(Into::into),
            tls_key_file: env("SS_WORKER_TLS_KEY").map(Into::into),
            disk_high_water_pct: env_parse("SS_WORKER_DISK_HIGH_WATER_PCT", 90)?,
            max_torrents: env_parse("SS_WORKER_MAX_TORRENTS", 12)?,
            max_leases: env_parse("SS_WORKER_MAX_LEASES", 8)?,
            // Held down on purpose. When the window moves, librqbit does not
            // send Cancel for requests already out — cancel_inflight_requests_for_piece
            // only fires when a piece is stolen — so every peer keeps
            // delivering blocks of the window we just left. Fewer peers is a
            // smaller overshoot to store before it can be released.
            per_torrent_peer_limit: env_parse("SS_WORKER_PEER_LIMIT", 40)?,
            upload_bps: env_parse::<u32>("SS_WORKER_UPLOAD_MBIT", 3)? * 125_000,
            download_bps: env_parse::<u32>("SS_WORKER_DOWNLOAD_MBIT", 0)? * 125_000,
            transfer_bps: env_parse::<u64>("SS_WORKER_TRANSFER_MBIT", 0)? * 125_000,
            idle_grace: env_secs("SS_WORKER_IDLE_GRACE_SECS", 120)?,
            reap_ttl: env_secs("SS_WORKER_REAP_TTL_SECS", 180)?,
            runtime_worker_threads: env_parse("SS_WORKER_RUNTIME_THREADS", 0)?,
            relayed: env("SS_WORKER_RELAYED").as_deref() == Some("1"),
            relay_upstream: env("SS_WORKER_RELAY_UPSTREAM"),
            response_cap: env_parse::<u64>("SS_WORKER_RESPONSE_CAP_MIB", 16)? * 1024 * 1024,
            first_byte_deadline: env_secs("SS_WORKER_FIRST_BYTE_SECS", 30)?,
            stall_deadline: env_secs("SS_WORKER_STALL_SECS", 20)?,
            drain_deadline: env_secs("SS_WORKER_DRAIN_SECS", 30)?,
            remux_slots: env_parse("SS_WORKER_REMUX_SLOTS", 1)?,
            ffmpeg_path: env("SS_WORKER_FFMPEG").unwrap_or_else(|| "ffmpeg".into()),
            ffprobe_path: env("SS_WORKER_FFPROBE").unwrap_or_else(|| "ffprobe".into()),
            remux_spool_bytes: env_parse::<u64>("SS_WORKER_REMUX_SPOOL_MIB", 512)? * 1024 * 1024,
            remux_object_bytes: env_parse::<u64>("SS_WORKER_REMUX_OBJECT_MIB", 256)? * 1024 * 1024,
            remux_put_concurrency: env_parse("SS_WORKER_REMUX_PUTS", 4)?,
            remux_put_global: env_parse("SS_WORKER_REMUX_PUTS_GLOBAL", 8)?,
            remux_ahead_ms: env_parse::<u64>("SS_WORKER_REMUX_AHEAD_SECS", 120)? * 1000,
        };
        if cfg.tls == TlsMode::Acme && cfg.public_ip.is_none() && cfg.public_hostname.is_none() {
            bail!("SS_WORKER_TLS=acme needs SS_WORKER_PUBLIC_IP and/or SS_WORKER_PUBLIC_HOSTNAME");
        }
        if cfg.tls == TlsMode::File && (cfg.tls_cert_file.is_none() || cfg.tls_key_file.is_none()) {
            bail!("SS_WORKER_TLS=file needs SS_WORKER_TLS_CERT and SS_WORKER_TLS_KEY");
        }
        if !(50..=99).contains(&cfg.disk_high_water_pct) {
            bail!("SS_WORKER_DISK_HIGH_WATER_PCT must be 50..99");
        }
        Ok(cfg)
    }

    // Every FileStream and every add_torrent holds one of librqbit's blocking
    // permits; the pool is sized for the leases this worker admits plus the
    // transient streams and inits around them.
    pub fn blocking_threads(&self) -> usize {
        if self.runtime_worker_threads > 0 {
            return self.runtime_worker_threads;
        }
        self.max_leases * 3 + 8
    }

    pub fn high_water_bytes(&self) -> u64 {
        self.disk_quota_bytes / 100 * self.disk_high_water_pct as u64
    }

    // What browsers are told to fetch from: the address the certificate names.
    pub fn public_base(&self) -> String {
        let scheme = if self.tls == TlsMode::Off {
            "http"
        } else {
            "https"
        };
        let host = match (&self.public_hostname, self.public_ip) {
            (Some(h), _) => h.clone(),
            (None, Some(IpAddr::V6(ip))) => format!("[{ip}]"),
            (None, Some(IpAddr::V4(ip))) => ip.to_string(),
            (None, None) => "127.0.0.1".into(),
        };
        let (port, default) = if self.tls == TlsMode::Off {
            (self.http_addr.port(), 80)
        } else {
            (self.https_addr.port(), 443)
        };
        if port == default {
            format!("{scheme}://{host}")
        } else {
            format!("{scheme}://{host}:{port}")
        }
    }
}

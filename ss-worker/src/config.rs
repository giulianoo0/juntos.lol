use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{bail, Context};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TlsMode {
    Acme,
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
    pub disk_quota_bytes: u64,
    pub disk_high_water_pct: u8,
    pub max_torrents: usize,
    pub max_leases: usize,
    pub per_torrent_peer_limit: usize,
    pub upload_bps: u32,
    pub download_bps: u32,
    pub idle_grace: Duration,
    pub reap_ttl: Duration,
    pub runtime_worker_threads: usize,
    pub response_cap: u64,
    pub first_byte_deadline: Duration,
    pub stall_deadline: Duration,
    pub drain_deadline: Duration,
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

impl WorkerConfig {
    pub fn load() -> anyhow::Result<Self> {
        let tls = match env("SS_WORKER_TLS").as_deref().unwrap_or("acme") {
            "acme" => TlsMode::Acme,
            "self-signed" => TlsMode::SelfSigned,
            "off" => TlsMode::Off,
            other => bail!("SS_WORKER_TLS={other}: expected acme, self-signed or off"),
        };
        let public_ip = match env("SS_WORKER_PUBLIC_IP") {
            Some(v) => Some(v.parse().context("SS_WORKER_PUBLIC_IP")?),
            None => None,
        };
        let cfg = Self {
            server_url: env("SS_WORKER_SERVER_URL").context("SS_WORKER_SERVER_URL is required")?,
            enrollment_token: env("SS_WORKER_ENROLLMENT_TOKEN"),
            data_dir: PathBuf::from(env("SS_WORKER_DATA_DIR").unwrap_or_else(|| "./data".into())),
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
            disk_quota_bytes: env_parse::<u64>("SS_WORKER_DISK_QUOTA_GB", 120)? * 1024 * 1024 * 1024,
            disk_high_water_pct: env_parse("SS_WORKER_DISK_HIGH_WATER_PCT", 90)?,
            max_torrents: env_parse("SS_WORKER_MAX_TORRENTS", 12)?,
            max_leases: env_parse("SS_WORKER_MAX_LEASES", 8)?,
            per_torrent_peer_limit: env_parse("SS_WORKER_PEER_LIMIT", 80)?,
            upload_bps: env_parse::<u32>("SS_WORKER_UPLOAD_MBIT", 3)? * 125_000,
            download_bps: env_parse::<u32>("SS_WORKER_DOWNLOAD_MBIT", 0)? * 125_000,
            idle_grace: env_secs("SS_WORKER_IDLE_GRACE_SECS", 120)?,
            reap_ttl: env_secs("SS_WORKER_REAP_TTL_SECS", 180)?,
            runtime_worker_threads: env_parse("SS_WORKER_RUNTIME_THREADS", 0)?,
            response_cap: env_parse::<u64>("SS_WORKER_RESPONSE_CAP_MIB", 16)? * 1024 * 1024,
            first_byte_deadline: env_secs("SS_WORKER_FIRST_BYTE_SECS", 30)?,
            stall_deadline: env_secs("SS_WORKER_STALL_SECS", 20)?,
            drain_deadline: env_secs("SS_WORKER_DRAIN_SECS", 30)?,
        };
        if cfg.tls == TlsMode::Acme && cfg.public_ip.is_none() && cfg.public_hostname.is_none() {
            bail!("SS_WORKER_TLS=acme needs SS_WORKER_PUBLIC_IP and/or SS_WORKER_PUBLIC_HOSTNAME");
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
        let scheme = if self.tls == TlsMode::Off { "http" } else { "https" };
        let host = match (&self.public_hostname, self.public_ip) {
            (Some(h), _) => h.clone(),
            (None, Some(IpAddr::V6(ip))) => format!("[{ip}]"),
            (None, Some(IpAddr::V4(ip))) => ip.to_string(),
            (None, None) => "127.0.0.1".into(),
        };
        let (port, default) = if self.tls == TlsMode::Off { (self.http_addr.port(), 80) } else { (self.https_addr.port(), 443) };
        if port == default {
            format!("{scheme}://{host}")
        } else {
            format!("{scheme}://{host}:{port}")
        }
    }
}

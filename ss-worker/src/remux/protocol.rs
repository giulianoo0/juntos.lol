use serde::Deserialize;

pub const PROTOCOL_VERSION: u32 = 1;

/// The remux block of a signed `remuxStart` job. The envelope's signature,
/// nonce, expiry and workerId still apply; this is only the payload the
/// supervisor consumes. No Debug derive: `claim` must never reach a log.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spec {
    pub protocol_version: u32,
    pub run_id: String,
    pub claim: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub metadata_token: Option<String>,
    pub media_generation: u64,
    pub region: u64,
    #[serde(default)]
    pub start_ms: u64,
    #[serde(default)]
    pub end_ms: u64,
    pub api_base: String,
    pub room_id: String,
    #[serde(default)]
    pub limits: Limits,
}

impl std::fmt::Debug for Spec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Spec")
            .field("run_id", &self.run_id)
            .field("media_generation", &self.media_generation)
            .field("region", &self.region)
            .field("start_ms", &self.start_ms)
            .field("room_id", &self.room_id)
            .finish_non_exhaustive()
    }
}

/// Server-signed ceilings. The worker clamps each to its own configuration:
/// a signed limit can lower a local ceiling, never raise it. Zero means the
/// local value stands.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    #[serde(default)]
    pub put_concurrency: usize,
    #[serde(default)]
    pub spool_bytes: u64,
    #[serde(default)]
    pub object_bytes: u64,
    #[serde(default)]
    #[allow(dead_code)]
    pub ahead_ms: u64,
}

impl Limits {
    pub fn clamp_puts(&self, local: usize) -> usize {
        if self.put_concurrency == 0 { local } else { self.put_concurrency.min(local) }
    }
    pub fn clamp_spool(&self, local: u64) -> u64 {
        if self.spool_bytes == 0 { local } else { self.spool_bytes.min(local) }
    }
    pub fn clamp_object(&self, local: u64) -> u64 {
        if self.object_bytes == 0 { local } else { self.object_bytes.min(local) }
    }
}

/// Run states, mirrored from internal/remux.
pub mod state {
    pub const ACCEPTED: &str = "accepted";
    pub const RUNNING: &str = "running";
    pub const DRAINING: &str = "draining";
    pub const COMPLETED: &str = "completed";
    pub const CANCELLED: &str = "cancelled";
    pub const FAILED: &str = "failed";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_lower_never_raise() {
        let l = Limits { put_concurrency: 8, spool_bytes: 0, object_bytes: 1024, ahead_ms: 0 };
        assert_eq!(l.clamp_puts(4), 4);
        assert_eq!(l.clamp_puts(16), 8);
        assert_eq!(l.clamp_spool(999), 999);
        assert_eq!(l.clamp_object(4096), 1024);
    }

    #[test]
    fn debug_never_prints_the_claim() {
        let spec: Spec = serde_json::from_value(serde_json::json!({
            "protocolVersion": 1, "runId": "r", "claim": "SECRET",
            "mediaGeneration": 0, "region": 0, "apiBase": "http://a", "roomId": "x"
        }))
        .unwrap();
        assert!(!format!("{spec:?}").contains("SECRET"));
    }
}

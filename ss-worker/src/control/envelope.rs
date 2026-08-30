use std::collections::HashMap;
use std::path::PathBuf;
use parking_lot::Mutex;

use anyhow::{bail, Context};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::ticket::now_secs;

/// A job the server signed for this worker. It names an infohash, never a
/// URL; it names this worker; it expires; and its nonce is remembered
/// across restarts so a captured envelope cannot be replayed after one.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub kind: String,
    pub job_id: String,
    pub worker_id: String,
    pub nonce: String,
    pub exp: u64,
    #[serde(default)]
    pub infohash: Option<String>,
    #[serde(default)]
    pub file_index: Option<usize>,
    #[serde(default)]
    pub room_id: Option<String>,
    #[serde(default)]
    pub lease_id: Option<String>,
    #[serde(default)]
    pub trackers: Vec<String>,
    #[serde(default)]
    pub jti: Option<String>,
    #[serde(default)]
    pub limits: Option<Limits>,
    #[serde(default)]
    pub remux: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub upload_bps: Option<u32>,
    pub download_bps: Option<u32>,
}

#[derive(Deserialize)]
pub struct Envelope {
    pub payload: String,
    pub sig: String,
}

pub struct NonceStore {
    path: PathBuf,
    seen: Mutex<HashMap<String, u64>>,
}

// A nonce is remembered for as long as its job could be replayed, capped
// so a far-off expiry cannot grow the file without bound.
const NONCE_TTL_CAP: u64 = 6 * 3600;

impl NonceStore {
    pub fn open(path: PathBuf) -> Self {
        let seen = match std::fs::read_to_string(&path) {
            Ok(raw) => match serde_json::from_str::<HashMap<String, u64>>(&raw) {
                Ok(seen) => seen,
                Err(e) => {
                    // A truncated store must not pass as an empty one in
                    // silence; the bad file is kept aside for inspection.
                    tracing::error!(error = %e, path = %path.display(), "nonce store unreadable; starting empty");
                    let _ = std::fs::rename(&path, path.with_extension("corrupt"));
                    HashMap::new()
                }
            },
            Err(_) => HashMap::new(),
        };
        Self { path, seen: Mutex::new(seen) }
    }

    /// Records a nonce; false when it was already seen.
    pub fn insert(&self, nonce: &str, exp: u64) -> bool {
        let mut seen = self.seen.lock();
        let now = now_secs();
        seen.retain(|_, e| *e > now);
        if seen.contains_key(nonce) {
            return false;
        }
        seen.insert(nonce.to_string(), exp.min(now + NONCE_TTL_CAP));
        if let Ok(raw) = serde_json::to_string(&*seen) {
            if let Err(e) = write_atomic(&self.path, raw.as_bytes()) {
                tracing::warn!(error = %e, "nonce store not persisted");
            }
        }
        true
    }
}

/// Writes through a sibling temp file and a rename, so a crash leaves
/// either the old file or the new one, never a torn one.
pub fn write_atomic(path: &std::path::Path, data: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, data)?;
    std::fs::rename(&tmp, path)
}

pub fn verify(envelope: &Envelope, key: &VerifyingKey, worker_id: &str, nonces: &NonceStore) -> anyhow::Result<Job> {
    let payload = B64.decode(&envelope.payload).context("envelope payload")?;
    let sig = B64.decode(&envelope.sig).context("envelope signature")?;
    let signature = Signature::from_slice(&sig).context("signature length")?;
    key.verify_strict(&payload, &signature).context("envelope signature")?;
    let job: Job = serde_json::from_slice(&payload).context("job payload")?;
    if job.worker_id != worker_id {
        bail!("job is for another worker");
    }
    if job.exp <= now_secs() {
        bail!("job expired");
    }
    if let Some(ih) = &job.infohash {
        if ih.len() != 40 || !ih.bytes().all(|b| b.is_ascii_hexdigit()) {
            bail!("job carries something other than an infohash");
        }
    }
    if !nonces.insert(&job.nonce, job.exp) {
        bail!("job replayed");
    }
    Ok(job)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn envelope(job: &Job, key: &SigningKey) -> Envelope {
        let payload = serde_json::to_vec(job).unwrap();
        Envelope { payload: B64.encode(&payload), sig: B64.encode(key.sign(&payload).to_bytes()) }
    }

    fn job(worker: &str, nonce: &str) -> Job {
        Job {
            kind: "lease".into(),
            job_id: "j1".into(),
            worker_id: worker.into(),
            nonce: nonce.into(),
            exp: now_secs() + 60,
            infohash: Some("b".repeat(40)),
            file_index: None,
            room_id: Some("r".into()),
            lease_id: None,
            trackers: vec![],
            jti: None,
            limits: None,
            remux: None,
        }
    }

    #[test]
    fn verifies_binds_and_refuses_replay() {
        let dir = std::env::temp_dir().join(format!("ssw-nonce-{}", std::process::id()));
        let _ = std::fs::remove_file(&dir);
        let nonces = NonceStore::open(dir.clone());
        let key = SigningKey::generate(&mut rand::thread_rng());
        let vk = key.verifying_key();
        let e = envelope(&job("w1", "n1"), &key);
        assert!(verify(&e, &vk, "w1", &nonces).is_ok());
        assert!(verify(&e, &vk, "w1", &nonces).is_err(), "replay");
        assert!(verify(&envelope(&job("w2", "n2"), &key), &vk, "w1", &nonces).is_err(), "other worker");
        let mut url = job("w1", "n3");
        url.infohash = Some("http://evil".into());
        assert!(verify(&envelope(&url, &key), &vk, "w1", &nonces).is_err(), "url instead of hash");
        // Survives a restart.
        let reopened = NonceStore::open(dir.clone());
        assert!(verify(&envelope(&job("w1", "n1"), &key), &vk, "w1", &reopened).is_err(), "replay after restart");
        let _ = std::fs::remove_file(&dir);
    }
}

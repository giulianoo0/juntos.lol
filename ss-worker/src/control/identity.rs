use std::path::Path;

use anyhow::Context;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};

/// Who this worker is: a keypair it generated itself (custody stays here,
/// like Tailscale's node keys), the id the server gave it at enrollment,
/// and the server key it verifies jobs and tickets against.
#[derive(Serialize, Deserialize, Default)]
pub struct Identity {
    #[serde(rename = "workerId")]
    pub worker_id: String,
    #[serde(rename = "secretKey")]
    secret_key: String,
    #[serde(rename = "serverPubkey")]
    pub server_pubkey: Option<String>,
}

impl Identity {
    pub fn load_or_create(path: &Path) -> anyhow::Result<Self> {
        if let Ok(raw) = std::fs::read_to_string(path) {
            return serde_json::from_str(&raw).context("identity.json");
        }
        Self::fresh(path)
    }

    /// A new keypair with no id and no server key yet, written over
    /// whatever was on disk. A hello signed by this asks to enroll, so
    /// nothing but the enrollment token can get it admitted.
    pub fn fresh(path: &Path) -> anyhow::Result<Self> {
        let key = SigningKey::generate(&mut rand::thread_rng());
        let id = Self { worker_id: String::new(), secret_key: B64.encode(key.to_bytes()), server_pubkey: None };
        id.save(path)?;
        Ok(id)
    }

    pub fn save(&self, path: &Path) -> anyhow::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        super::envelope::write_atomic(path, serde_json::to_string_pretty(self)?.as_bytes())?;
        Ok(())
    }

    pub fn signing_key(&self) -> anyhow::Result<SigningKey> {
        let bytes: [u8; 32] = B64.decode(&self.secret_key)?.try_into().map_err(|_| anyhow::anyhow!("secret key length"))?;
        Ok(SigningKey::from_bytes(&bytes))
    }

    pub fn pubkey_b64(&self) -> anyhow::Result<String> {
        Ok(B64.encode(self.signing_key()?.verifying_key().to_bytes()))
    }

    pub fn server_key(&self) -> anyhow::Result<Option<VerifyingKey>> {
        let Some(raw) = &self.server_pubkey else { return Ok(None) };
        Ok(Some(parse_pubkey(raw)?))
    }

    pub fn sign(&self, message: &[u8]) -> anyhow::Result<String> {
        Ok(B64.encode(self.signing_key()?.sign(message).to_bytes()))
    }
}

pub fn parse_pubkey(raw: &str) -> anyhow::Result<VerifyingKey> {
    let bytes: [u8; 32] = B64.decode(raw)?.try_into().map_err(|_| anyhow::anyhow!("public key length"))?;
    VerifyingKey::from_bytes(&bytes).context("public key")
}

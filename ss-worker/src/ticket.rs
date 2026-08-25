use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};

// The credential a browser presents on the data plane, minted by the server
// and verified here without a round trip. It travels in the URL path so the
// GET stays a simple request: a header would cost a preflight per read.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Ticket {
    #[serde(rename = "room")]
    pub room_id: String,
    #[serde(rename = "ih")]
    pub infohash: String,
    #[serde(rename = "file")]
    pub file_index: usize,
    #[serde(rename = "aud")]
    pub audience: String,
    #[serde(rename = "wid")]
    pub worker_id: String,
    pub exp: u64,
    pub jti: String,
}

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub fn verify(raw: &str, key: &VerifyingKey, worker_id: &str) -> anyhow::Result<Ticket> {
    let (payload, sig) = raw.split_once('.').context("ticket has no signature")?;
    let payload_bytes = B64.decode(payload).context("ticket payload")?;
    let sig_bytes = B64.decode(sig).context("ticket signature")?;
    let signature = Signature::from_slice(&sig_bytes).context("ticket signature length")?;
    key.verify_strict(&payload_bytes, &signature).context("ticket signature")?;
    let ticket: Ticket = serde_json::from_slice(&payload_bytes).context("ticket payload")?;
    if ticket.worker_id != worker_id {
        bail!("ticket is for another worker");
    }
    if ticket.exp <= now_secs() {
        bail!("ticket expired");
    }
    if ticket.infohash.len() != 40 || !ticket.infohash.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("ticket infohash");
    }
    Ok(ticket)
}

#[cfg(test)]
pub fn mint(ticket: &Ticket, key: &ed25519_dalek::SigningKey) -> String {
    use ed25519_dalek::Signer;
    let payload = serde_json::to_vec(ticket).unwrap();
    let sig = key.sign(&payload);
    format!("{}.{}", B64.encode(&payload), B64.encode(sig.to_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;

    fn ticket(worker: &str, exp: u64) -> Ticket {
        Ticket {
            room_id: "r1".into(),
            infohash: "a".repeat(40),
            file_index: 0,
            audience: "https://ss.example".into(),
            worker_id: worker.into(),
            exp,
            jti: "j1".into(),
        }
    }

    #[test]
    fn round_trip_and_rejections() {
        let key = SigningKey::generate(&mut rand::thread_rng());
        let vk = key.verifying_key();
        let good = mint(&ticket("w1", now_secs() + 60), &key);
        assert_eq!(verify(&good, &vk, "w1").unwrap().room_id, "r1");
        assert!(verify(&good, &vk, "w2").is_err(), "another worker");
        assert!(verify(&mint(&ticket("w1", now_secs() - 1), &key), &vk, "w1").is_err(), "expired");
        let other = SigningKey::generate(&mut rand::thread_rng());
        assert!(verify(&mint(&ticket("w1", now_secs() + 60), &other), &vk, "w1").is_err(), "wrong key");
        let mut tampered = good.clone();
        tampered.replace_range(0..1, if good.starts_with('A') { "B" } else { "A" });
        assert!(verify(&tampered, &vk, "w1").is_err(), "tampered");
    }
}

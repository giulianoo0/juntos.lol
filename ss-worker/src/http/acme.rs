use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use parking_lot::Mutex;
use std::time::Duration;

use anyhow::{bail, Context};
use instant_acme::{
    Account, AccountCredentials, CertificateIdentifier, ChallengeType, Identifier, NewAccount, NewOrder, OrderStatus,
    RetryPolicy,
};
use rustls_pki_types::CertificateDer;
use serde::{Deserialize, Serialize};

use super::tls::{self, CertSlot};
use crate::config::WorkerConfig;

/// Certificates without a domain: Let's Encrypt issues for IP addresses on
/// the short-lived profile, validated over http-01 on port 80. Renewals go
/// through ARI, which is exempt from the rate limits, so the only budget a
/// worker spends is its first issuance.
///
/// Everything lives under data_dir/tls: the account, the current cert and
/// key, and the identifier of the cert the next order must say it replaces
/// — persisted so a restart never asks to replace the same predecessor
/// twice, which the CA refuses.
pub struct Acme {
    cfg: WorkerConfig,
    slot: Arc<CertSlot>,
    challenges: Arc<Mutex<HashMap<String, String>>>,
    pub last_result: Mutex<Option<String>>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct State {
    /// The ARI identifier of the certificate currently installed, as its
    /// two base64url parts.
    cert_id: Option<(String, String)>,
    /// Whether an order already named `cert_id` as its predecessor.
    replaced: bool,
}

impl State {
    fn identifier(&self) -> Option<CertificateIdentifier<'static>> {
        let (aki, serial) = self.cert_id.clone()?;
        Some(CertificateIdentifier { authority_key_identifier: aki.into(), serial: serial.into() })
    }
}

const SHORTLIVED_RENEW_AT: f64 = 0.5;
const READY_MARGIN_SECS: i64 = 60 * 60;

impl Acme {
    pub fn new(cfg: WorkerConfig, slot: Arc<CertSlot>) -> Self {
        Self { cfg, slot, challenges: Arc::new(Mutex::new(HashMap::new())), last_result: Mutex::new(None) }
    }

    pub fn challenges(&self) -> Arc<Mutex<HashMap<String, String>>> {
        self.challenges.clone()
    }

    fn dir(&self) -> std::path::PathBuf {
        self.cfg.data_dir.join("tls")
    }

    /// Installs what is on disk, if anything usable is there.
    pub fn load_existing(&self) -> anyhow::Result<bool> {
        let dir = self.dir();
        let (Ok(cert), Ok(key)) = (std::fs::read_to_string(dir.join("cert.pem")), std::fs::read_to_string(dir.join("key.pem")))
        else {
            return Ok(false);
        };
        let (chain, key) = tls::parse_pem(&cert, &key)?;
        if tls::not_after(&chain[0])? <= crate::ticket::now_secs() as i64 {
            return Ok(false);
        }
        self.slot.install(chain, key)?;
        Ok(true)
    }

    fn identifiers(&self) -> Vec<Identifier> {
        let mut ids = Vec::new();
        if let Some(name) = &self.cfg.public_hostname {
            ids.push(Identifier::Dns(name.clone()));
        }
        if let Some(ip) = self.cfg.public_ip {
            ids.push(Identifier::Ip(ip));
        }
        ids
    }

    async fn account(&self) -> anyhow::Result<Account> {
        let path = self.dir().join("account.json");
        if let Ok(raw) = std::fs::read_to_string(&path) {
            let creds: AccountCredentials = serde_json::from_str(&raw).context("account.json")?;
            return Ok(Account::builder()?.from_credentials(creds).await?);
        }
        let contact: Vec<String> = self.cfg.acme_contact.iter().map(|c| format!("mailto:{c}")).collect();
        let contact_refs: Vec<&str> = contact.iter().map(String::as_str).collect();
        let (account, creds) = Account::builder()?
            .create(
                &NewAccount { contact: &contact_refs, terms_of_service_agreed: true, only_return_existing: false },
                self.cfg.acme_directory.clone(),
                None,
            )
            .await?;
        std::fs::create_dir_all(self.dir())?;
        std::fs::write(&path, serde_json::to_string(&creds)?)?;
        Ok(account)
    }

    fn state(&self) -> State {
        std::fs::read_to_string(self.dir().join("state.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn save_state(&self, state: &State) -> anyhow::Result<()> {
        std::fs::create_dir_all(self.dir())?;
        std::fs::write(self.dir().join("state.json"), serde_json::to_string(state)?)?;
        Ok(())
    }

    /// One issuance: order, answer http-01 for every identifier, finalize,
    /// install, persist.
    pub async fn issue(&self) -> anyhow::Result<()> {
        let account = self.account().await?;
        let identifiers = self.identifiers();
        if identifiers.is_empty() {
            bail!("nothing to certify");
        }
        let mut state = self.state();
        let mut order_req = NewOrder::new(&identifiers).profile(&self.cfg.acme_profile);
        let replaces = if state.replaced { None } else { state.identifier() };
        if let Some(id) = replaces.clone() {
            order_req = order_req.replaces(id);
        }
        let mut order = match account.new_order(&order_req).await {
            Ok(o) => o,
            // A CA that rejects the replaces hint still issues without it;
            // the hint is a rate-limit exemption, not a requirement.
            Err(e) if replaces.is_some() => {
                tracing::warn!(error = %e, "order with replaces refused; retrying without");
                account.new_order(&NewOrder::new(&identifiers).profile(&self.cfg.acme_profile)).await?
            }
            Err(e) => return Err(e.into()),
        };
        if replaces.is_some() {
            state.replaced = true;
            self.save_state(&state)?;
        }

        let mut authorizations = order.authorizations();
        while let Some(result) = authorizations.next().await {
            let mut authz = result?;
            if matches!(authz.status, instant_acme::AuthorizationStatus::Valid) {
                continue;
            }
            let mut challenge = authz.challenge(ChallengeType::Http01).context("no http-01 challenge offered")?;
            let token = challenge.token.clone();
            let key_auth = challenge.key_authorization().as_str().to_string();
            self.challenges.lock().insert(token.clone(), key_auth);
            challenge.set_ready().await?;
        }
        let status = order.poll_ready(&RetryPolicy::default()).await?;
        self.challenges.lock().clear();
        if status != OrderStatus::Ready {
            bail!("order ended {status:?}");
        }
        let key_pem = order.finalize().await?;
        let cert_pem = order.poll_certificate(&RetryPolicy::default()).await?;
        let (chain, key) = tls::parse_pem(&cert_pem, &key_pem)?;
        let cert_id = CertificateIdentifier::try_from(&chain[0])
            .ok()
            .map(|c| (c.authority_key_identifier.into_owned(), c.serial.into_owned()));
        self.slot.install(chain, key)?;
        std::fs::create_dir_all(self.dir())?;
        std::fs::write(self.dir().join("cert.pem"), &cert_pem)?;
        std::fs::write(self.dir().join("key.pem"), &key_pem)?;
        self.save_state(&State { cert_id, replaced: false })?;
        tracing::info!(not_after = ?self.slot.not_after(), "certificate installed");
        Ok(())
    }

    /// When the next renewal should happen: ARI's window when the CA offers
    /// one, otherwise halfway through the certificate's life.
    async fn next_renewal(&self) -> Duration {
        let Some(not_after) = self.slot.not_after() else { return Duration::ZERO };
        let now = crate::ticket::now_secs() as i64;
        let fallback = || {
            let life = self.cert_life_secs().unwrap_or(160 * 3600);
            let at = not_after - (life as f64 * (1.0 - SHORTLIVED_RENEW_AT)) as i64;
            Duration::from_secs((at - now).max(60) as u64)
        };
        let Some(id) = self.state().identifier() else { return fallback() };
        let Ok(account) = self.account().await else { return fallback() };
        match account.renewal_info(&id).await {
            Ok((info, _)) => {
                let start = info.suggested_window.start.unix_timestamp();
                let end = info.suggested_window.end.unix_timestamp();
                let at = if end > start { start + rand::random::<i64>().rem_euclid(end - start) } else { start };
                Duration::from_secs((at - now).max(60) as u64)
            }
            Err(e) => {
                tracing::debug!(error = %e, "no ARI window");
                fallback()
            }
        }
    }

    fn cert_life_secs(&self) -> Option<u64> {
        let pem = std::fs::read_to_string(self.dir().join("cert.pem")).ok()?;
        let chain: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut pem.as_bytes()).filter_map(Result::ok).collect();
        let (_, parsed) = x509_parser::parse_x509_certificate(chain.first()?.as_ref()).ok()?;
        let v = parsed.validity();
        Some((v.not_after.timestamp() - v.not_before.timestamp()).max(0) as u64)
    }

    /// Keeps the certificate alive for the process's lifetime.
    pub async fn run(self: Arc<Self>) {
        loop {
            let wait = if self.slot.ready(READY_MARGIN_SECS) { self.next_renewal().await } else { Duration::ZERO };
            tokio::time::sleep(wait).await;
            match self.issue().await {
                Ok(()) => {
                    *self.last_result.lock() = Some("ok".into());
                }
                Err(e) => {
                    tracing::error!(error = %e, "certificate issuance failed");
                    *self.last_result.lock() = Some(format!("error: {e:#}"));
                    tokio::time::sleep(Duration::from_secs(if self.slot.ready(0) { 3600 } else { 300 })).await;
                }
            }
        }
    }
}

pub fn ip_names(cfg: &WorkerConfig) -> Vec<String> {
    let mut names = vec!["localhost".to_string(), "127.0.0.1".to_string()];
    if let Some(name) = &cfg.public_hostname {
        names.push(name.clone());
    }
    if let Some(ip) = cfg.public_ip {
        names.push(match ip {
            IpAddr::V4(v4) => v4.to_string(),
            IpAddr::V6(v6) => v6.to_string(),
        });
    }
    names
}

use std::sync::Arc;

use anyhow::Context;
use arc_swap::ArcSwapOption;
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use rustls::ServerConfig;
use rustls_pki_types::{CertificateDer, PrivateKeyDer};

/// The certificate the listener presents, swappable under live connections
/// so a renewal never drops a stream. SNI is ignored on purpose: browsers
/// send none for an IP-literal URL (RFC 6066), and this worker has exactly
/// one identity to offer anyway.
#[derive(Default)]
pub struct CertSlot {
    current: ArcSwapOption<CertifiedKey>,
    not_after: std::sync::atomic::AtomicI64,
}

impl CertSlot {
    pub fn install(&self, chain: Vec<CertificateDer<'static>>, key: PrivateKeyDer<'static>) -> anyhow::Result<()> {
        let not_after = not_after(&chain[0])?;
        let signing = rustls::crypto::ring::sign::any_supported_type(&key).context("private key")?;
        self.current.store(Some(Arc::new(CertifiedKey::new(chain, signing))));
        self.not_after.store(not_after, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }

    pub fn not_after(&self) -> Option<i64> {
        let v = self.not_after.load(std::sync::atomic::Ordering::Relaxed);
        (v > 0).then_some(v)
    }

    /// Whether the certificate is present and still valid for `margin` secs.
    pub fn ready(&self, margin: i64) -> bool {
        self.not_after().is_some_and(|t| t - crate::ticket::now_secs() as i64 > margin)
    }
}

impl std::fmt::Debug for CertSlot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CertSlot").field("not_after", &self.not_after()).finish()
    }
}

impl ResolvesServerCert for CertSlot {
    fn resolve(&self, _hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        self.current.load_full()
    }
}

pub fn server_config(slot: Arc<CertSlot>) -> Arc<ServerConfig> {
    let mut cfg = ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .expect("protocol versions")
        .with_no_client_auth()
        .with_cert_resolver(slot);
    cfg.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    Arc::new(cfg)
}

pub fn not_after(cert: &CertificateDer<'_>) -> anyhow::Result<i64> {
    let (_, parsed) = x509_parser::parse_x509_certificate(cert.as_ref()).context("parse certificate")?;
    Ok(parsed.validity().not_after.timestamp())
}

/// A throwaway certificate for development: browsers need
/// --ignore-certificate-errors, curl needs -k.
pub fn self_signed(names: Vec<String>) -> anyhow::Result<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>)> {
    let key = rcgen::KeyPair::generate()?;
    let params = rcgen::CertificateParams::new(names)?;
    let cert = params.self_signed(&key)?;
    let key_der = PrivateKeyDer::try_from(key.serialize_der()).map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok((vec![cert.der().clone()], key_der))
}

/// Reads a PEM pair from disk into the slot.
pub fn install_from_files(slot: &CertSlot, cert: &std::path::Path, key: &std::path::Path) -> anyhow::Result<()> {
    let cert_pem = std::fs::read_to_string(cert).with_context(|| format!("read {}", cert.display()))?;
    let key_pem = std::fs::read_to_string(key).with_context(|| format!("read {}", key.display()))?;
    let (chain, key) = parse_pem(&cert_pem, &key_pem)?;
    slot.install(chain, key)
}

pub fn parse_pem(cert_pem: &str, key_pem: &str) -> anyhow::Result<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>)> {
    let chain = rustls_pemfile::certs(&mut cert_pem.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .context("certificate pem")?;
    if chain.is_empty() {
        anyhow::bail!("certificate pem has no certificates");
    }
    let key = rustls_pemfile::private_key(&mut key_pem.as_bytes())
        .context("key pem")?
        .context("key pem has no key")?;
    Ok((chain, key))
}

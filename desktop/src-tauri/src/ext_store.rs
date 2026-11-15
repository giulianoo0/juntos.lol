//! What an extension keeps between runs, such as its sign-in. The webview does
//! not keep an extension frame's storage on disk, so the site asks the app for
//! it on the extension's behalf. Each extension gets one file under the app's
//! data dir, sealed with AES-256-GCM under a key that lives in the system's
//! keychain (Keychain on macOS, Credential Manager on Windows), never on disk.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine;
use parking_lot::Mutex;
use rand::RngCore;

const KEYCHAIN_SERVICE: &str = "lol.juntos.desktop";
const KEYCHAIN_ACCOUNT: &str = "extension-storage";
const MAX_KEY: usize = 128;
const MAX_VALUE: usize = 64 << 10;
const MAX_TOTAL: usize = 256 << 10;
const MAX_KEYS: usize = 64;
const NONCE: usize = 12;

pub struct ExtStore {
    dir: PathBuf,
    secret: Box<dyn Fn() -> Result<[u8; 32], String> + Send + Sync>,
    key: Mutex<Option<[u8; 32]>>,
    files: Mutex<()>,
}

impl ExtStore {
    pub fn new(dir: PathBuf) -> Self {
        Self::with_secret(dir, keychain_secret)
    }

    fn with_secret(dir: PathBuf, secret: impl Fn() -> Result<[u8; 32], String> + Send + Sync + 'static) -> Self {
        Self { dir, secret: Box::new(secret), key: Mutex::new(None), files: Mutex::new(()) }
    }

    pub fn get(&self, id: &str, key: &str) -> Result<Option<String>, String> {
        check(id, key)?;
        let _files = self.files.lock();
        Ok(self.read(id)?.remove(key))
    }

    /// Keeps `value` under `key`, or forgets the key when it is None.
    pub fn set(&self, id: &str, key: &str, value: Option<String>) -> Result<(), String> {
        check(id, key)?;
        let _files = self.files.lock();
        let mut kept = self.read(id)?;
        match value {
            Some(value) => {
                if value.len() > MAX_VALUE {
                    return Err("value_too_large".into());
                }
                kept.insert(key.to_string(), value);
            }
            None => {
                kept.remove(key);
            }
        }
        if kept.len() > MAX_KEYS || kept.iter().map(|(k, v)| k.len() + v.len()).sum::<usize>() > MAX_TOTAL {
            return Err("store_full".into());
        }
        self.write(id, &kept)
    }

    fn cipher(&self) -> Result<Aes256Gcm, String> {
        let mut key = self.key.lock();
        if key.is_none() {
            *key = Some((self.secret)()?);
        }
        Ok(Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key.as_ref().expect("key"))))
    }

    fn path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.sealed"))
    }

    fn read(&self, id: &str) -> Result<BTreeMap<String, String>, String> {
        let sealed = match std::fs::read(self.path(id)) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
            Err(e) => return Err(e.to_string()),
        };
        if sealed.len() < NONCE {
            return Ok(BTreeMap::new());
        }
        let (nonce, body) = sealed.split_at(NONCE);
        // A file that does not open under this key (another machine's, or
        // tampered with) is as good as none: the extension signs in again.
        let Ok(plain) = self.cipher()?.decrypt(Nonce::from_slice(nonce), Payload { msg: body, aad: id.as_bytes() }) else {
            return Ok(BTreeMap::new());
        };
        Ok(serde_json::from_slice(&plain).unwrap_or_default())
    }

    fn write(&self, id: &str, kept: &BTreeMap<String, String>) -> Result<(), String> {
        let path = self.path(id);
        if kept.is_empty() {
            return match std::fs::remove_file(&path) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
                _ => Ok(()),
            };
        }
        let plain = serde_json::to_vec(kept).map_err(|e| e.to_string())?;
        let mut nonce = [0u8; NONCE];
        rand::thread_rng().fill_bytes(&mut nonce);
        let body = self
            .cipher()?
            .encrypt(Nonce::from_slice(&nonce), Payload { msg: &plain, aad: id.as_bytes() })
            .map_err(|_| "seal_failed".to_string())?;
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let temp = self.dir.join(format!("{id}.sealed.tmp"));
        std::fs::write(&temp, [nonce.as_slice(), &body].concat()).map_err(|e| e.to_string())?;
        restrict(&temp);
        std::fs::rename(&temp, &path).map_err(|e| e.to_string())
    }
}

/// Extension ids as internal/extension/manifest.go takes them, so an id never walks out of the dir.
fn check(id: &str, key: &str) -> Result<(), String> {
    let id_ok = (3..=32).contains(&id.len())
        && id.starts_with(|c: char| c.is_ascii_lowercase())
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !id_ok {
        return Err("bad_extension".into());
    }
    if key.is_empty() || key.len() > MAX_KEY || key.chars().any(char::is_control) {
        return Err("bad_key".into());
    }
    Ok(())
}

#[cfg(unix)]
fn restrict(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict(_: &Path) {}

/// The sealing key, made once per machine and kept in the system keychain.
fn keychain_secret() -> Result<[u8; 32], String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|e| e.to_string())?;
    let engine = base64::engine::general_purpose::STANDARD;
    match entry.get_password() {
        Ok(kept) => engine
            .decode(kept.trim())
            .ok()
            .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
            .ok_or_else(|| "keychain_key_unreadable".to_string()),
        Err(keyring::Error::NoEntry) => {
            let mut key = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut key);
            entry.set_password(&engine.encode(key)).map_err(|e| e.to_string())?;
            Ok(key)
        }
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(dir: &Path, key: u8) -> ExtStore {
        ExtStore::with_secret(dir.to_path_buf(), move || Ok([key; 32]))
    }

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ext-store-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn keeps_a_value_sealed_across_runs() {
        let dir = temp();
        store(&dir, 7).set("tomato", "tomato.session", Some("{\"refresh\":\"segredo\"}".into())).unwrap();

        let on_disk = std::fs::read(dir.join("tomato.sealed")).unwrap();
        assert!(!String::from_utf8_lossy(&on_disk).contains("segredo"), "o arquivo não guarda nada em claro");
        assert_eq!(store(&dir, 7).get("tomato", "tomato.session").unwrap().as_deref(), Some("{\"refresh\":\"segredo\"}"));
    }

    #[test]
    fn another_key_or_another_extension_reads_nothing() {
        let dir = temp();
        store(&dir, 7).set("tomato", "s", Some("v".into())).unwrap();
        std::fs::copy(dir.join("tomato.sealed"), dir.join("outra.sealed")).unwrap();

        assert_eq!(store(&dir, 8).get("tomato", "s").unwrap(), None);
        assert_eq!(store(&dir, 7).get("outra", "s").unwrap(), None, "o arquivo de uma extensão não abre como de outra");
    }

    #[test]
    fn forgetting_the_last_key_removes_the_file() {
        let dir = temp();
        let s = store(&dir, 7);
        s.set("tomato", "s", Some("v".into())).unwrap();
        s.set("tomato", "s", None).unwrap();
        assert!(!dir.join("tomato.sealed").exists());
        assert_eq!(s.get("tomato", "s").unwrap(), None);
    }

    #[test]
    fn refuses_ids_that_leave_the_dir_and_oversized_values() {
        let dir = temp();
        let s = store(&dir, 7);
        assert!(s.get("../x", "s").is_err());
        assert!(s.get("Tomato", "s").is_err());
        assert!(s.set("tomato", "", Some("v".into())).is_err());
        assert!(s.set("tomato", "s", Some("x".repeat(MAX_VALUE + 1))).is_err());
        for n in 0..MAX_KEYS {
            s.set("tomato", &format!("k{n}"), Some("v".into())).unwrap();
        }
        assert_eq!(s.set("tomato", "mais", Some("v".into())).unwrap_err(), "store_full");
    }
}

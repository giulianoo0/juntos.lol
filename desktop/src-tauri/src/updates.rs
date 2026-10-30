//! The app updates itself from the GitHub release's `latest.json`: checked
//! at launch and every few hours, downloaded in the background, and applied
//! only when the person restarts from the site's notice, or when the app
//! closes. A room never restarts under anyone.
use parking_lot::Mutex;
use serde::Serialize;

pub const CHECK_EVERY: std::time::Duration = std::time::Duration::from_secs(6 * 60 * 60);

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Status {
    Idle,
    Checking,
    #[serde(rename_all = "camelCase")]
    Downloading { version: String, received: u64, total: Option<u64> },
    #[serde(rename_all = "camelCase")]
    Ready { version: String },
    #[serde(rename_all = "camelCase")]
    Failed { error: String },
}

/// What the updater holds between the download and the install. `P` is the
/// downloaded update; the tests use a plain value.
pub struct Updates<P> {
    status: Mutex<Status>,
    pending: Mutex<Option<P>>,
}

impl<P> Default for Updates<P> {
    fn default() -> Self {
        Self { status: Mutex::new(Status::Idle), pending: Mutex::new(None) }
    }
}

impl<P> Updates<P> {
    pub fn status(&self) -> Status {
        self.status.lock().clone()
    }

    /// Whether a check may start: not while one runs, and not over a ready update.
    pub fn begin_check(&self) -> bool {
        let mut status = self.status.lock();
        if matches!(*status, Status::Checking | Status::Downloading { .. } | Status::Ready { .. }) {
            return false;
        }
        *status = Status::Checking;
        true
    }

    pub fn downloading(&self, version: &str, received: u64, total: Option<u64>) {
        *self.status.lock() = Status::Downloading { version: version.into(), received, total };
    }

    pub fn ready(&self, version: &str, payload: P) {
        *self.pending.lock() = Some(payload);
        *self.status.lock() = Status::Ready { version: version.into() };
    }

    pub fn nothing_new(&self) {
        *self.status.lock() = Status::Idle;
    }

    pub fn failed(&self, error: &str) {
        *self.status.lock() = Status::Failed { error: error.chars().take(300).collect() };
    }

    /// The downloaded update, once: a restart or the app closing installs it.
    pub fn take(&self) -> Option<P> {
        self.pending.lock().take()
    }
}

/// The update and its downloaded bytes, waiting for the install.
pub type Pending = (tauri_plugin_updater::Update, Vec<u8>);
pub type AppUpdates = Updates<Pending>;

/// Checks now and then every CHECK_EVERY, for the life of the app.
pub fn spawn_checks(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            check_once(&app).await;
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

/// One check; a found update is downloaded in the background and waits ready.
pub async fn check_once(app: &tauri::AppHandle) {
    use tauri::Manager;
    use tauri_plugin_updater::UpdaterExt;

    let updates = app.state::<AppUpdates>();
    if !updates.begin_check() {
        return;
    }
    let mut builder = app.updater_builder();
    // Dev and the local test point at their own latest.json.
    if let Some(url) = std::env::var("JUNTOS_UPDATE_URL").ok().and_then(|raw| url::Url::parse(&raw).ok()) {
        builder = match builder.endpoints(vec![url]) {
            Ok(next) => next,
            Err(e) => return updates.failed(&e.to_string()),
        };
    }
    let found = match builder.build() {
        Ok(updater) => updater.check().await,
        Err(e) => Err(e),
    };
    let update = match found {
        Ok(Some(update)) => update,
        Ok(None) => return updates.nothing_new(),
        Err(e) => {
            tracing::warn!(error = %e, "update check failed");
            return updates.failed(&e.to_string());
        }
    };
    let version = update.version.clone();
    tracing::info!(%version, "update found; downloading");
    let mut received = 0u64;
    let downloaded = update
        .download(
            |chunk, total| {
                received += chunk as u64;
                updates.downloading(&version, received, total);
            },
            || {},
        )
        .await;
    match downloaded {
        Ok(bytes) => {
            tracing::info!(%version, "update ready");
            updates.ready(&version, (update, bytes));
        }
        Err(e) => {
            tracing::warn!(error = %e, "update download failed");
            updates.failed(&e.to_string());
        }
    }
}

/// Installs a downloaded update; true when one was there.
pub fn install_pending(app: &tauri::AppHandle) -> bool {
    use tauri::Manager;
    let Some((update, bytes)) = app.state::<AppUpdates>().take() else { return false };
    match update.install(bytes) {
        Ok(()) => true,
        Err(e) => {
            tracing::warn!(error = %e, "update install failed");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_found_update_downloads_then_waits_ready() {
        let updates = Updates::<&str>::default();
        assert!(updates.begin_check());
        assert_eq!(updates.status(), Status::Checking);
        assert!(!updates.begin_check());
        updates.downloading("0.1.1", 10, Some(100));
        assert_eq!(updates.status(), Status::Downloading { version: "0.1.1".into(), received: 10, total: Some(100) });
        updates.ready("0.1.1", "bytes");
        assert_eq!(updates.status(), Status::Ready { version: "0.1.1".into() });
        assert!(!updates.begin_check(), "a ready update is not checked over");
    }

    #[test]
    fn the_update_installs_once() {
        let updates = Updates::<&str>::default();
        updates.ready("0.1.1", "bytes");
        assert_eq!(updates.take(), Some("bytes"));
        assert_eq!(updates.take(), None);
    }

    #[test]
    fn nothing_new_or_a_failure_lets_the_next_check_run() {
        let updates = Updates::<&str>::default();
        assert!(updates.begin_check());
        updates.nothing_new();
        assert_eq!(updates.status(), Status::Idle);
        assert!(updates.begin_check());
        updates.failed("offline");
        assert_eq!(updates.status(), Status::Failed { error: "offline".into() });
        assert!(updates.begin_check());
    }

    #[test]
    fn the_status_reads_as_the_site_expects() {
        let ready = serde_json::to_value(Status::Ready { version: "0.1.1".into() }).unwrap();
        assert_eq!(ready, serde_json::json!({ "state": "ready", "version": "0.1.1" }));
    }
}

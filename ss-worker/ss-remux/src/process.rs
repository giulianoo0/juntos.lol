use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use parking_lot::Mutex;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

/// FFmpeg under supervision: structured argv (no shell), a minimal
/// environment, a bounded stderr tail and a kill that always lands.
pub struct Supervised {
    child: Child,
    pub stderr_tail: Arc<Mutex<String>>,
    #[allow(dead_code)]
    pub progress_ms: Arc<std::sync::atomic::AtomicU64>,
}

const STDERR_TAIL_BYTES: usize = 8 * 1024;

pub fn spawn(binary: &str, args: &[String]) -> anyhow::Result<Supervised> {
    let mut child = Command::new(binary)
        .args(args)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("spawn {binary}"))?;

    let stderr_tail = Arc::new(Mutex::new(String::new()));
    if let Some(stderr) = child.stderr.take() {
        let tail = stderr_tail.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut held = tail.lock();
                held.push_str(&line);
                held.push('\n');
                if held.len() > STDERR_TAIL_BYTES {
                    let cut = held.len() - STDERR_TAIL_BYTES;
                    held.drain(..cut);
                }
            }
        });
    }
    let progress_ms = Arc::new(std::sync::atomic::AtomicU64::new(0));
    if let Some(stdout) = child.stdout.take() {
        let progress = progress_ms.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(value) = line.strip_prefix("out_time_us=").or_else(|| line.strip_prefix("out_time_ms=")) {
                    if let Ok(us) = value.trim().parse::<i64>() {
                        progress.store((us / 1000).max(0) as u64, std::sync::atomic::Ordering::Relaxed);
                    }
                }
            }
        });
    }
    Ok(Supervised { child, stderr_tail, progress_ms })
}

impl Supervised {
    #[allow(dead_code)]
    pub async fn wait(&mut self) -> anyhow::Result<std::process::ExitStatus> {
        Ok(self.child.wait().await?)
    }

    pub fn child_try_wait(&mut self) -> anyhow::Result<Option<std::process::ExitStatus>> {
        Ok(self.child.try_wait()?)
    }

    /// Kill with a short grace: SIGKILL if it does not exit on its own.
    pub async fn kill(&mut self) {
        let _ = self.child.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(5), self.child.wait()).await;
    }
}

/// Runs a bounded one-shot helper (ffprobe) and returns its stdout.
pub async fn run_capture(binary: &str, args: &[String], timeout: Duration) -> anyhow::Result<String> {
    let output = tokio::time::timeout(
        timeout,
        Command::new(binary)
            .args(args)
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .with_context(|| format!("{binary} timed out"))?
    .with_context(|| format!("run {binary}"))?;
    if !output.status.success() {
        anyhow::bail!("{binary} failed: {}", String::from_utf8_lossy(&output.stderr).chars().take(500).collect::<String>());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Detects the pinned FFmpeg once at boot; None voids the capability.
pub async fn detect_version(binary: &str) -> Option<String> {
    let out = run_capture(binary, &["-version".into()], Duration::from_secs(10)).await.ok()?;
    let first = out.lines().next()?;
    first.split_whitespace().nth(2).map(|v| v.to_string())
}

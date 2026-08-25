use std::io::Write;

/// The setup wizard: a handful of questions, an env file, done. No GUI —
/// the worker is a service; what it needs is a good first five minutes.
pub fn setup() -> anyhow::Result<()> {
    println!("\nss-worker setup — answers are written to ss-worker.env; Enter keeps the default.\n");
    let mut out = String::from("# ss-worker — written by `ss-worker setup`\n");
    let mut put = |key: &str, value: String| {
        if !value.is_empty() {
            out.push_str(&format!("{key}={value}\n"));
        }
    };
    let server = ask("Server WSS url (e.g. wss://ss.example.com/ws/worker-link)", "")?;
    if server.is_empty() {
        anyhow::bail!("the server url is the one thing setup cannot guess");
    }
    put("SS_WORKER_SERVER_URL", server);
    put("SS_WORKER_ENROLLMENT_TOKEN", ask("Enrollment token (from the server's WORKER_ENROLLMENT_SECRET; only needed once)", "")?);
    let tls = ask("TLS mode: acme (public IP, ports 80/443), self-signed (dev), off (behind a local reverse proxy)", "acme")?;
    put("SS_WORKER_TLS", tls.clone());
    match tls.as_str() {
        "acme" => {
            put("SS_WORKER_PUBLIC_IP", ask("This machine's public IP (what the certificate names)", "")?);
            put("SS_WORKER_PUBLIC_HOSTNAME", ask("Public hostname, if any (blank for IP-only)", "")?);
        }
        "off" => {
            put("SS_WORKER_HTTP_ADDR", ask("Local address to serve on (your proxy forwards /v1/* here)", "127.0.0.1:8444")?);
        }
        _ => {
            put("SS_WORKER_HTTPS_ADDR", ask("Address to serve https on", "0.0.0.0:8443")?);
            put("SS_WORKER_PUBLIC_IP", ask("Address browsers reach this machine at", "127.0.0.1")?);
        }
    }
    put("SS_WORKER_DATA_DIR", ask("Data directory (torrents, identity, certs)", "/var/lib/ss-worker")?);
    put("SS_WORKER_DISK_QUOTA_GB", ask("Disk quota, GB", "120")?);
    put("SS_WORKER_TRANSFER_MBIT", ask("Serving bandwidth cap, Mbit/s (0 = uncapped; workers near it report full)", "0")?);
    put("SS_WORKER_UPLOAD_MBIT", ask("Swarm seeding cap, Mbit/s", "3")?);
    put("SS_WORKER_BT_PORT", ask("BitTorrent port", "4240")?);
    std::fs::write("ss-worker.env", &out)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions("ss-worker.env", std::fs::Permissions::from_mode(0o600));
    }
    println!("\nWrote ss-worker.env. Start with:\n\n  ss-worker\n");
    println!("It loads ss-worker.env from the working directory (or SS_WORKER_ENV_FILE).");
    println!("As a service, point a systemd unit at it:\n");
    println!("  [Service]\n  ExecStart=/usr/local/bin/ss-worker\n  WorkingDirectory=/var/lib/ss-worker\n  Restart=always\n");
    Ok(())
}

fn ask(question: &str, default: &str) -> anyhow::Result<String> {
    if default.is_empty() {
        print!("  {question}: ");
    } else {
        print!("  {question} [{default}]: ");
    }
    std::io::stdout().flush()?;
    let mut line = String::new();
    std::io::stdin().read_line(&mut line)?;
    let answer = line.trim();
    Ok(if answer.is_empty() { default.to_string() } else { answer.to_string() })
}

pub fn help() {
    println!(
        "ss-worker {} — remote torrent worker for ss\n\n\
         USAGE:\n  ss-worker            run (loads ./ss-worker.env or $SS_WORKER_ENV_FILE, env wins)\n  \
         ss-worker setup      interactive setup, writes ss-worker.env\n  \
         ss-worker --help     this\n  ss-worker --version\n\n\
         Every option is an SS_WORKER_* environment variable; see the README.",
        env!("CARGO_PKG_VERSION")
    );
}

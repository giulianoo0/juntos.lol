use std::fmt::Write;
use std::sync::atomic::Ordering;

use crate::http::{tls::CertSlot, AppState, FIRST_BYTE_BOUNDS};

/// Prometheus text exposition, hand-rolled: a dozen series do not need a
/// client library.
pub fn render(state: &AppState, slot: Option<&CertSlot>) -> String {
    let m = &state.metrics;
    let snap = state.engine.snapshot();
    let mut out = String::new();
    let _ = writeln!(out, "# TYPE ssw_range_requests_total counter\nssw_range_requests_total {}", m.range_requests.load(Ordering::Relaxed));
    let _ = writeln!(out, "# TYPE ssw_bytes_served_total counter\nssw_bytes_served_total {}", m.bytes_served.load(Ordering::Relaxed));
    let _ = writeln!(out, "# TYPE ssw_range_stalls_total counter\nssw_range_stalls_total {}", m.stalls.load(Ordering::Relaxed));
    let _ = writeln!(out, "# TYPE ssw_first_byte_timeouts_total counter\nssw_first_byte_timeouts_total {}", m.first_byte_timeouts.load(Ordering::Relaxed));
    let _ = writeln!(out, "# TYPE ssw_in_flight gauge\nssw_in_flight {}", m.in_flight.load(Ordering::Relaxed));
    let _ = writeln!(out, "# TYPE ssw_disk_used_bytes gauge\nssw_disk_used_bytes {}", snap.disk_used);
    let _ = writeln!(out, "# TYPE ssw_disk_quota_bytes gauge\nssw_disk_quota_bytes {}", snap.disk_quota);
    let _ = writeln!(out, "# TYPE ssw_torrents gauge\nssw_torrents {}", snap.torrents.len());
    let _ = writeln!(out, "# TYPE ssw_leases gauge\nssw_leases {}", snap.leases);
    let _ = writeln!(out, "# TYPE ssw_permits_in_use gauge\nssw_permits_in_use {}", snap.permits_in_use);
    let _ = writeln!(out, "# TYPE ssw_draining gauge\nssw_draining {}", snap.draining as u8);
    let _ = writeln!(out, "# TYPE ssw_range_first_byte_seconds histogram");
    for (i, bound) in FIRST_BYTE_BOUNDS.iter().enumerate() {
        let _ = writeln!(out, "ssw_range_first_byte_seconds_bucket{{le=\"{bound}\"}} {}", m.first_byte_buckets[i].load(Ordering::Relaxed));
    }
    let count = m.first_byte_count.load(Ordering::Relaxed);
    let _ = writeln!(out, "ssw_range_first_byte_seconds_bucket{{le=\"+Inf\"}} {count}");
    let _ = writeln!(out, "ssw_range_first_byte_seconds_sum {}", m.first_byte_sum_ms.load(Ordering::Relaxed) as f64 / 1000.0);
    let _ = writeln!(out, "ssw_range_first_byte_seconds_count {count}");
    let _ = writeln!(out, "# TYPE ssw_range_stall_seconds_sum counter\nssw_range_stall_seconds_sum {}", m.stall_sum_ms.load(Ordering::Relaxed) as f64 / 1000.0);
    let expiry = slot.and_then(|s| s.not_after()).map(|t| t - crate::ticket::now_secs() as i64).unwrap_or(0);
    let _ = writeln!(out, "# TYPE ssw_cert_expiry_seconds gauge\nssw_cert_expiry_seconds {expiry}");
    let peers: u64 = snap.torrents.iter().map(|t| t.peers).sum();
    let _ = writeln!(out, "# TYPE ssw_peers gauge\nssw_peers {peers}");
    out
}
